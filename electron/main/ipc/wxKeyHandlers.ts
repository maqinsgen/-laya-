import { ipcMain } from 'electron'
import { setTimeout as wait } from 'timers/promises'
import { join } from 'path'
import { accessSync, constants, existsSync, statSync } from 'fs'
import { dbPathService } from '../../services/dbPathService'
import { wcdbService } from '../../services/wcdbService'
import { wxKeyService } from '../../services/wxKeyService'
import { wxKeyServiceMac } from '../../services/wxKeyServiceMac'
import { wechatLoginCaptureService } from '../../services/wechatLoginCaptureService'
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
  } else {
    try {
      require.resolve('koffi')
      componentReady = supported && existsSync(wxKeyService.getScanDllPath())
    } catch { /* Missing native dependency is reported as a blocker. */ }
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

        try {
          const safeScanWxids = (root: string): string[] => {
            try {
              return dbPathService.scanWxids(root)
            } catch {
              return []
            }
          }

          // DLL 返回的是“干净 wxid”（wxid_7r9dov5f7mse12），而真实账号目录名带后缀
          // （wxid_7r9dov5f7mse12_bf70）。全 app 的 wxid 字段约定为目录名，故按前缀解析出真实目录。
          const resolveAccountDir = (root: string, cleanWxid: string): string => {
            if (!cleanWxid) return ''
            const dirs = safeScanWxids(root)
            return (
              dirs.find(d => d === cleanWxid) ||
              dirs.find(d => d.startsWith(cleanWxid + '_')) ||
              dirs.find(d => d.startsWith(cleanWxid)) ||
              ''
            )
          }

          // 首选方案：对已登录、正在运行的微信直接扫内存（global_config 结构游走），
          // 一次性提取 db_key + 账号字段（wxid/昵称/微信号/手机号），无需退出重登。
          if (wxKeyService.isWeChatRunning()) {
            sendStatus({ status: '检测到微信正在运行，正在直接读取账号信息...', level: 1 })
            const account = await wxKeyService.scanAccountAsync(signal)
            signal.throwIfAborted()
            if (account?.dbKey) {
              // 把干净 wxid 解析成真实目录名，作为 app 内统一使用的 wxid（路径都按它拼）。
              const resolvedDir = dbPath ? resolveAccountDir(dbPath, account.wxid) : ''
              const bindWxid = resolvedDir || account.wxid
              const outAccount = { ...account, wxid: bindWxid }
              // 有数据库目录时做一次目录验证；拿到 dbKey 本身已通过 UUIDv4 自校验，
              // 即使无目录/未通过验证也直接返回密钥与账号信息。
              if (dbPath) {
                const accWxids = bindWxid
                  ? [bindWxid, ...safeScanWxids(dbPath).filter(w => w !== bindWxid)]
                  : safeScanWxids(dbPath)
                for (const wxid of accWxids) {
                  sendStatus({ status: `已读取账号信息，正在验证: ${account.name || wxid}`, level: 1 })
                  const testResult = await wcdbService.testConnection(dbPath, account.dbKey, wxid)
                  signal.throwIfAborted()
                  if (testResult.success) {
                    ctx.getLogService()?.info('WxKey', '直接读取账号信息成功（无需重启微信）', {
                      wxid, hasName: !!account.name, hasNumber: !!account.number, hasPhone: !!account.phone
                    })
                    return { success: true, key: account.dbKey, validatedWxid: wxid, account: { ...account, wxid } }
                  }
                }
              }
              // 未做/未通过目录验证：不回填 validatedWxid（前端据此标记为“未验证”），
              // 但仍带回解析后的目录名供前端自动绑定目录。
              ctx.getLogService()?.info('WxKey', '直接读取到账号信息（未通过目录验证），返回密钥与账号', { bindWxid })
              return { success: true, key: account.dbKey, account: outAccount }
            }
            ctx.getLogService()?.info('WxKey', '直接读取未命中，尝试当前进程的候选密钥扫描')
          }

          // 保留当前微信会话；部分版本只在登录时加载密钥，未命中时给出手动重登指引。
          signal.throwIfAborted()

          // 解析候选账号目录，定位 contact.db（决定校验用的 salt）
          if (!dbPath) {
            return { success: false, error: '缺少数据库路径，无法定位 contact.db' }
          }
          const wxids: string[] = []
          const pushWxid = (value?: string | null) => {
            const wxid = String(value || '').trim()
            if (wxid && !wxids.includes(wxid)) wxids.push(wxid)
          }
          const acct = wxKeyService.detectCurrentAccount(dbPath, 10) || wxKeyService.detectCurrentAccount(dbPath, 60)
          pushWxid(acct?.wxid)
          try {
            for (const wxid of dbPathService.scanWxids(dbPath)) pushWxid(wxid)
          } catch {
            // ignore
          }
          if (wxids.length === 0) {
            return { success: false, error: '未在数据库目录下找到微信账号' }
          }

          const contactDbFor = (wxid: string): string | undefined => {
            return [
              join(dbPath, wxid, 'db_storage', 'contact', 'contact.db'),
              join(dbPath, 'db_storage', 'contact', 'contact.db'),
            ].find(existsSync)
          }

          // 持续只读扫描，命中后验证数据库。仅原生诊断确认无法打开进程时提示权限问题。
          sendStatus({ status: '正在读取当前微信进程，请打开任意聊天触发数据库访问...', level: 1 })
          const deadline = Date.now() + 120000
          let lastError = ''
          let sawBytes = false
          let rounds = 0
          let sawDiagnostic = false
          let sawPermissionDenied = false
          const needAdminResult = {
            success: false,
            needAdmin: true,
            error: '无法读取微信内存（读到 0 字节），通常是权限不足。请确认微信与本应用使用相同的权限级别，必要时以管理员身份重开本应用，或填入已有密钥。'
          }
          const noDataResult = () => ({
            success: false,
            error: lastError || (sawDiagnostic
              ? '暂未读取到微信数据。请确认已登录并打开任意聊天；当前微信版本也可能不支持自动获取。'
              : '读取组件未返回诊断结果，请检查所选数据目录，或手动填入已有密钥。'),
          })
          while (Date.now() < deadline) {
            signal.throwIfAborted()
            if (!wxKeyService.isWeChatRunning()) return { success: false, error: '微信已退出。请手动打开并登录后重试。' }
            rounds++
            // 快速路径：一次性从 global_config 结构提取 db_key + 账号字段（wxid/昵称/微信号/手机号），
            // 不依赖 contact.db。命中后把干净 wxid 前缀匹配成真实目录名，再优先做数据库验证。
            const account = await wxKeyService.scanAccountAsync(signal)
            signal.throwIfAborted()
            if (account?.dbKey) {
              sawBytes = true
              const bindWxid =
                wxids.find(w => w === account.wxid) ||
                wxids.find(w => w.startsWith(account.wxid + '_')) ||
                wxids.find(w => w.startsWith(account.wxid)) ||
                account.wxid
              const accWxids = bindWxid
                ? [bindWxid, ...wxids.filter(w => w !== bindWxid)]
                : wxids
              for (const wxid of accWxids) {
                sendStatus({ status: `已提取账号信息，正在验证: ${account.name || wxid}`, level: 1 })
                const testResult = await wcdbService.testConnection(dbPath, account.dbKey, wxid)
                signal.throwIfAborted()
                if (testResult.success) {
                  ctx.getLogService()?.info('WxKey', '账号信息提取成功', {
                    wxid, hasName: !!account.name, hasNumber: !!account.number, hasPhone: !!account.phone
                  })
                  return { success: true, key: account.dbKey, validatedWxid: wxid, account: { ...account, wxid } }
                }
                lastError = redactWechatKey(testResult.error)
              }
            }
            for (const wxid of wxids) {
              const contactDb = contactDbFor(wxid)
              if (!contactDb) continue
              const diag = await wxKeyService.scanDbKeyDiagAsync(contactDb, signal)
              signal.throwIfAborted()
              if (!diag) continue
              sawDiagnostic = true
              if (!diag.auth) return { success: false, error: '微信读取组件校验失败，请重新安装完整版本。' }
              if (!diag.dbOk) {
                lastError = '无法读取用于校验的 contact.db，请确认所选数据目录属于已登录账号。'
                continue
              }
              if (diag.pids > 0 && diag.opened === 0) sawPermissionDenied = true
              if (diag.bytes > 0) sawBytes = true
              if (diag.key) {
                sendStatus({ status: `已捕获候选密钥，正在验证账号: ${wxid}`, level: 1 })
                const testResult = await wcdbService.testConnection(dbPath, diag.key, wxid)
                signal.throwIfAborted()
                if (testResult.success) {
                  ctx.getLogService()?.info('WxKey', '内存扫描密钥获取成功', { wxid, keyLength: diag.key.length })
                  return { success: true, key: diag.key, validatedWxid: wxid, account: account ?? null }
                }
                lastError = redactWechatKey(testResult.error)
              }
            }
            // 区分无结果、目录错误与进程权限不足，避免把缺失组件误报为需要提权。
            if (rounds >= 3 && !sawBytes) {
              ctx.getLogService()?.warn('WxKey', '未读到微信数据', { sawDiagnostic, sawPermissionDenied })
              return sawPermissionDenied ? needAdminResult : noDataResult()
            }
            await wait(1500, undefined, { signal })
          }

          if (!sawBytes) {
            ctx.getLogService()?.warn('WxKey', '内存读取结束但未读到微信数据', { sawDiagnostic, sawPermissionDenied })
            return sawPermissionDenied ? needAdminResult : noDataResult()
          }
          ctx.getLogService()?.warn('WxKey', '内存扫描超时未获取到密钥', { lastError })
          return {
            success: false,
            error: lastError || '扫描超时未获取到密钥。请先打开任意聊天后重试；某些微信版本仅在登录时加载密钥，可手动退出账号再登录，然后重试，或填入已有密钥。'
          }
        } catch (e) {
          ctx.getLogService()?.error('WxKey', '获取密钥异常', { error: redactWechatKey(e) })
          return { success: false, error: redactWechatKey(e) }
        }
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

    if (process.platform === 'darwin') {
      // Acknowledgment means the login capture has finished cleaning up, not
      // merely that cancellation was requested while WeChat is still attached.
      await completion
      return true
    }
    wxKeyService.dispose()
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
