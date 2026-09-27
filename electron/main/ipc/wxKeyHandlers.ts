import { ipcMain } from 'electron'
import { accessSync, constants, statSync } from 'fs'
import { wxKeyService } from '../../services/wxKeyService'
import { wxKeyServiceMac } from '../../services/wxKeyServiceMac'
import { wechatLoginCaptureService } from '../../services/wechatLoginCaptureService'
import { windowsWechatKeyService } from '../../services/windowsWechatKeyService'
import type { MainProcessContext } from '../context'
import { buildWechatPreflight, redactWechatKey, type WechatPreflightReport } from '../../../src/shared/wechatConnection'

async function checkPreflight(dbPath?: string): Promise<WechatPreflightReport> {
  let database: 'ready' | 'missing' | 'unreadable' = 'missing'
  if (dbPath) {
    try {
      accessSync(dbPath, constants.R_OK)
      database = statSync(dbPath).isDirectory() ? 'ready' : 'unreadable'
    } catch { database = 'unreadable' }
  }
  const supported = process.platform === 'darwin' || process.platform === 'win32'
  let componentReady = false
  let componentError: string | undefined
  if (process.platform === 'darwin') {
    const runtime = await wechatLoginCaptureService.checkRuntime()
    componentReady = runtime.ready
    componentError = runtime.error
  } else if (process.platform === 'win32') {
    const runtime = windowsWechatKeyService.checkRuntime()
    componentReady = runtime.ready
    componentError = runtime.error
  }
  const security = process.platform === 'darwin' ? await wxKeyServiceMac.checkSipStatus() : undefined
  return buildWechatPreflight({
    platform: process.platform, arch: process.arch, componentReady, componentError, database,
    running: supported && (process.platform === 'darwin' ? wxKeyServiceMac.isWeChatRunning() : wxKeyService.isWeChatRunning()),
    security: security ? security.error ? 'unknown' : security.enabled ? 'enabled' : 'disabled' : undefined,
  })
}

/**
 * 微信密钥获取 IPC。
 * macOS 和 Windows 流程不同，wxkey:status 是前端步骤提示依赖的进度事件。
 */
export function registerWxKeyHandlers(ctx: MainProcessContext): void {
  let activeAcquisition: AbortController | null = null
  let activeCompletion: Promise<void> | null = null
  ipcMain.handle('wxkey:preflight', async (_, dbPath?: string) => checkPreflight(dbPath))
  ipcMain.handle('wxkey:isWeChatRunning', async () => {
    if (process.platform === 'darwin') {
      return wxKeyServiceMac.isWeChatRunning()
    }
    return wxKeyService.isWeChatRunning()
  })

  ipcMain.handle('wxkey:getWeChatPid', async () => {
    if (process.platform === 'darwin') {
      return wxKeyServiceMac.getWeChatPid()
    }
    return wxKeyService.getWeChatPid()
  })

  ipcMain.handle('wxkey:killWeChat', async () => {
    if (process.platform === 'darwin') {
      return wxKeyServiceMac.killWeChat()
    }
    return wxKeyService.killWeChat()
  })

  ipcMain.handle('wxkey:launchWeChat', async (_, customWechatPath?: string) => {
    if (process.platform === 'darwin') {
      return wxKeyServiceMac.launchWeChat(customWechatPath)
    }
    return wxKeyService.launchWeChat(customWechatPath)
  })

  ipcMain.handle('wxkey:waitForWindow', async (_, maxWaitSeconds?: number) => {
    if (process.platform === 'darwin') {
      return wxKeyServiceMac.waitForWeChatWindow(maxWaitSeconds)
    }
    return wxKeyService.waitForWeChatWindow(maxWaitSeconds)
  })

  ipcMain.handle('wxkey:startGetKey', async (event, customWechatPath?: string, dbPath?: string, wxid?: string) => {
    if (activeAcquisition) return { success: false, error: '已有获取任务正在结束，请稍后再试。' }
    const operation = new AbortController()
    activeAcquisition = operation
    let resolveCompletion!: () => void
    const completion = new Promise<void>(resolve => { resolveCompletion = resolve })
    activeCompletion = completion
    const signal = operation.signal
    const cancel = () => { operation.abort() }
    const cancelOnDocumentNavigation = (
      details: { isMainFrame?: boolean; isSameDocument?: boolean },
      _url?: string, isInPlace?: boolean, isMainFrame?: boolean,
    ) => {
      // A full reload keeps the WebContents alive but destroys the IPC caller.
      // Hash/history navigation and subframe loads do not abandon that caller.
      // Positional arguments support Electron versions preceding event details.
      const mainFrame = details.isMainFrame ?? isMainFrame
      const sameDocument = details.isSameDocument ?? isInPlace
      if (mainFrame === true && sameDocument === false) cancel()
    }
    event.sender.once('destroyed', cancel)
    event.sender.on('did-start-navigation', cancelOnDocumentNavigation)
    event.sender.once('render-process-gone', cancel)
    const sendStatus = (data: { status?: string; level: number }) => {
      if (!signal.aborted && !event.sender.isDestroyed()) {
        event.sender.send('wxkey:status', { ...data, status: redactWechatKey(data.status) })
      }
    }
    try {
      const preflight = await checkPreflight(dbPath)
      signal.throwIfAborted()
      if (!preflight.canAutoGet) return { success: false, error: preflight.summary, preflight }
      const result = await (async () => {
        ctx.getLogService()?.info('WxKey', '开始获取微信密钥')
        if (process.platform === 'darwin') {
          if (!dbPath) return { success: false, error: '请先选择微信数据目录，再进行登录时获取。' }
          const result = await wechatLoginCaptureService.capture({
            dbPath, wxid, signal,
            onStatus: (status, level) => sendStatus({ status, level }),
          })
          signal.throwIfAborted()
          if (!result.success) {
            const error = redactWechatKey(result.error || '登录时获取未完成，请按提示重试。')
            ctx.getLogService()?.warn('WxKey', 'macOS 登录时获取未完成', { error })
            return { success: false, error }
          }
          // The capture service confirms detach and validates the fresh value
          // against account databases before exposing it to the renderer.
          if (!result.key || !/^[0-9a-f]{64}$/i.test(result.key) || !result.validatedWxid) {
            return { success: false, error: '捕获结果尚未通过完整账号验证，原连接已保留。' }
          }
          ctx.getLogService()?.info('WxKey', 'macOS 登录时获取及账号验证成功')
          return { success: true, key: result.key, validatedWxid: result.validatedWxid }
        }

        if (!dbPath) return { success: false, error: '请先选择微信数据目录和账号。' }
        return windowsWechatKeyService.capture({
          dbPath, wxid, signal,
          onStatus: (status, level) => sendStatus({ status, level }),
        })
      })()
      signal.throwIfAborted()
      return result
    } catch (error) {
      if (signal.aborted) return { success: false, cancelled: true, error: '已取消获取密钥' }
      ctx.getLogService()?.error('WxKey', '获取密钥异常', { error: redactWechatKey(error) })
      return { success: false, error: redactWechatKey(error) }
    } finally {
      event.sender.removeListener('destroyed', cancel)
      event.sender.removeListener('did-start-navigation', cancelOnDocumentNavigation)
      event.sender.removeListener('render-process-gone', cancel)
      if (activeAcquisition === operation) activeAcquisition = null
      if (activeCompletion === completion) activeCompletion = null
      resolveCompletion()
    }
  })

  ipcMain.handle('wxkey:cancel', async () => {
    const completion = activeCompletion
    activeAcquisition?.abort()

    // Acknowledge only after either platform has released its acquisition job.
    await completion
    return true
  })

  ipcMain.handle('wxkey:detectCurrentAccount', async (_, dbPath?: string, maxTimeDiffMinutes?: number) => {
    if (process.platform === 'darwin') {
      return wxKeyServiceMac.detectCurrentAccount(dbPath, maxTimeDiffMinutes)
    }
    return wxKeyService.detectCurrentAccount(dbPath, maxTimeDiffMinutes)
  })

  // 数据库路径相关

}
