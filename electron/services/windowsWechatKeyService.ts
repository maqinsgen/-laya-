import { fork, type ChildProcess, type ForkOptions } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { safeStorage } from 'electron'
import { getAppPath, isElectronPackaged } from './runtimePaths'
import { getElectronWorkerEnv } from './workerEnvironment'
import { discoverWechatDatabases, verifyWechatRawKey, verifyWechatKeyCandidates, type WechatDatabaseAccount } from './wechatDatabaseKeys'
import { saveWechatKeyring, type WechatDatabaseKeyring } from './wechatKeyring'
import { wcdbService } from './wcdbService'
import { redactWechatKey } from '../../src/shared/wechatConnection'

const SCAN_MS = 90_000
const STOP_MS = 3_000
export class WindowsWechatKeyService {
  private stoppingWorkers = new Set<ChildProcess>()
  getWorkerPath(): string {
    return join(isElectronPackaged() ? process.resourcesPath : getAppPath(), 'resources', 'windows', 'wechat-key-scan.cjs')
  }
  checkRuntime(): { ready: boolean; error?: string } {
    try {
      if (this.stoppingWorkers.size) return { ready: false, error: '上一次扫描进程仍在停止，请稍后重试或重启应用。' }
      if (process.platform !== 'win32' || process.arch !== 'x64') return { ready: false, error: '自动获取需要 Windows x64 和微信 4.x。' }
      require.resolve('koffi')
      require.resolve('better-sqlite3-multiple-ciphers')
      if (!existsSync(this.getWorkerPath())) throw new Error()
      if (!safeStorage.isEncryptionAvailable()) return { ready: false, error: '系统安全存储不可用，暂不能保存微信逐库密钥。' }
      return { ready: true }
    } catch { return { ready: false, error: 'Windows 读取组件不完整，请安装包含新版数据库组件的完整版本。' } }
  }
  private scan(account: WechatDatabaseAccount, signal: AbortSignal, onStatus: (text: string, level: number) => void): Promise<WechatDatabaseKeyring> {
    signal.throwIfAborted()
    const pages = new Map<string, typeof account.databases>()
    for (const db of account.databases) {
      const group = pages.get(db.salt) || []; group.push(db); pages.set(db.salt, group)
    }
    return new Promise((resolve, reject) => {
      let child: ChildProcess
      let outcome: { keys?: WechatDatabaseKeyring; error?: Error } | undefined
      let done = false
      let workerExited = false
      let stopTimer: ReturnType<typeof setTimeout> | undefined
      const keys: WechatDatabaseKeyring = {}
      const deadline = setTimeout(() => stop(new Error('扫描时间已到，尚未验证全部数据库。请打开最近的聊天后重试。')), SCAN_MS + 5_000)
      const cleanup = () => { clearTimeout(deadline); if (stopTimer) clearTimeout(stopTimer); signal.removeEventListener('abort', abort) }
      const settle = () => {
        if (done || !outcome) return
        done = true; cleanup()
        if (signal.aborted) reject(new Error('已取消获取密钥'))
        else if (outcome.error) reject(outcome.error)
        else resolve(outcome.keys!)
      }
      const stop = (error?: Error, value?: WechatDatabaseKeyring) => {
        if (outcome) return
        outcome = { error, keys: value }
        if (workerExited) { settle(); return }
        if (child) {
          this.stoppingWorkers.add(child)
          // Let the worker close process handles in its finally blocks first.
          // On Windows, child.kill() forcibly terminates rather than delivering SIGTERM.
          try { child.send({ type: 'cancel' }, () => {}) } catch { /* The deadline below fails closed. */ }
          stopTimer = setTimeout(() => {
            try { child.kill('SIGKILL') } catch { /* Never terminate WeChat. */ }
            outcome = { error: new Error('扫描进程未能及时结束，本次结果未保存，请重启应用后重试。') }
            settle()
          }, STOP_MS)
        } else settle()
      }
      const abort = () => stop(new Error('已取消获取密钥'))
      signal.addEventListener('abort', abort, { once: true })
      try {
        const workerOptions: ForkOptions & { windowsHide: boolean } = {
          execPath: process.execPath, execArgv: [], windowsHide: true,
          env: { ...getElectronWorkerEnv(), ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'json',
        }
        child = fork(this.getWorkerPath(), [], workerOptions)
        // Never copy native stdout/stderr into logs: it may contain process data.
        child.stdout?.resume(); child.stderr?.resume()
        child.on('error', () => stop(new Error('无法启动 Windows 只读扫描组件。')))
        const onWorkerClosed = () => {
          this.stoppingWorkers.delete(child)
          workerExited = true
          if (!outcome) outcome = { error: new Error('扫描组件提前结束，未保存候选密钥。') }
          settle()
        }
        child.on('exit', onWorkerClosed)
        child.on('close', onWorkerClosed)
        child.on('message', (raw: unknown) => {
          if (done || outcome || signal.aborted || !raw || typeof raw !== 'object') return
          const message = raw as Record<string, unknown>
          if (message.type === 'candidate') {
            if (typeof message.key !== 'string' || !/^[0-9a-f]{64}$/i.test(message.key) || typeof message.salt !== 'string' || !/^[0-9a-f]{32}$/i.test(message.salt)) return
            const salt = message.salt.toLowerCase(); const key = message.key.toLowerCase()
            const group = pages.get(salt)
            if (!group || keys[salt] || !group.every(db => verifyWechatRawKey(key, salt, db.page))) return
            keys[salt] = key
            const report = verifyWechatKeyCandidates(account, new Map(Object.entries(keys)))
            onStatus(`已校验 ${report.coreVerified}/${report.coreTotal} 个核心数据库，正在继续读取…`, 1)
            if (report.success) stop(undefined, report.keysBySalt)
          } else if (message.type === 'progress') {
            if (['regions','scannedBytes','candidates'].every(k => Number.isSafeInteger(message[k]) && (message[k] as number) >= 0)) {
              onStatus(`正在只读扫描：${message.regions} 个内存区 · ${Math.round((message.scannedBytes as number) / 1048576)} MB`, 1)
            }
          } else if (message.type === 'done') {
            const count = account.databases.filter(db => db.core && keys[db.salt]).length
            stop(new Error(message.reason === 'no-process' ? '未找到微信 4.x（Weixin.exe）。请先打开并登录电脑版微信。'
              : message.reason === 'permission-denied' ? '系统拒绝读取微信进程。请确认微信与本应用使用相同权限，必要时以管理员身份重开本应用。'
              : `已验证 ${count}/${account.databases.filter(db => db.core).length} 个核心数据库。请打开近期聊天后重试；若仍缺失，可退出账号重新登录后再扫描。`))
          } else if (message.type === 'error') stop(new Error('Windows 扫描组件未完成，本次候选未保存。'))
        })
        child.send({ type: 'scan', salts: [...pages.keys()].filter(salt => /^[0-9a-f]{32}$/.test(salt)), timeoutMs: SCAN_MS }, error => { if (error) stop(new Error('扫描组件通信失败，本次结果未保存。')) })
        if (signal.aborted) abort()
      } catch { stop(new Error('无法启动 Windows 只读扫描组件。')) }
    })
  }
  async capture(input: { dbPath: string; wxid?: string; signal: AbortSignal; onStatus: (text: string, level: number) => void }): Promise<{success: boolean; key?: string; validatedWxid?: string; error?: string}> {
    try {
      const runtime = this.checkRuntime()
      if (!runtime.ready) return { success: false, error: runtime.error }
      input.signal.throwIfAborted()
      const account = discoverWechatDatabases(input.dbPath, input.wxid)
      if (!account.databases.some(db => db.core)) return { success: false, error: '所选账号还没有可验证的加密聊天数据库，请确认目录、登录微信并打开聊天后重试。' }
      input.onStatus(`已定位所选账号的 ${account.databases.filter(db => db.core).length} 个核心数据库，正在只读获取对应密钥…`, 1)
      const keys = await this.scan(account, input.signal, input.onStatus)
      input.signal.throwIfAborted()
      // Re-read headers after scanning: a replaced/moved database must not reuse
      // an earlier salt match or stale authentication result.
      const fresh = discoverWechatDatabases(input.dbPath, account.wxid)
      const verified = verifyWechatKeyCandidates(fresh, new Map(Object.entries(keys)))
      if (!verified.success || !verified.primaryKey) return { success: false, error: '数据库在扫描期间发生变化或仍缺少密钥，请重新获取。' }
      input.onStatus('密钥已通过逐库校验，正在测试数据库读取…', 1)
      const opened = await wcdbService.testConnection(fresh.dbStoragePath, verified.primaryKey, fresh.wxid, verified.keysBySalt)
      input.signal.throwIfAborted()
      if (!opened.success) return { success: false, error: `密钥已校验，但数据库读取未通过：${redactWechatKey(opened.error || '读取组件不可用')}。本次未保存连接，请更新完整应用后重试。` }
      saveWechatKeyring(fresh.dbStoragePath, fresh.wxid, verified.primaryKey, verified.keysBySalt)
      return { success: true, key: verified.primaryKey, validatedWxid: fresh.wxid }
    } catch (error) {
      return { success: false, error: input.signal.aborted ? '已取消获取密钥' : redactWechatKey(error) }
    }
  }
}
export const windowsWechatKeyService = new WindowsWechatKeyService()
