import { app } from 'electron'
import { execFile, type ChildProcess } from 'child_process'
import { constants, promises as fs } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { tmpdir } from 'os'
import { createHmac, pbkdf2, randomUUID, timingSafeEqual } from 'crypto'

export interface WechatLoginCaptureOptions {
  dbPath: string
  wxid?: string
  signal?: AbortSignal
  onStatus?: (status: string, level: number) => void
}
export interface WechatLoginCaptureResult {
  success: boolean
  key?: string
  validatedWxid?: string
  error?: string
}
type Account = { directory: string; wxid?: string }
type Target = { pid: number; executable: string; startTime: string }
type Progress = { stage: string; captured?: boolean; detached?: boolean; finished?: boolean }
type Authorization = { child: ChildProcess; done: Promise<string> }
type Timings = { authorization: number; monitor: number; cleanup: number; poll: number }

class CaptureError extends Error {}

const CANCELLED = '已取消登录密钥获取。'
const CLEANUP_FAILED = '监听未能确认安全结束。没有接受新密钥；请手动退出并重新打开微信后再试。'
const FILE_CLEANUP_FAILED = '临时密钥文件未能安全清理，没有接受新的密钥。请检查临时目录权限后重试。'
const READY = '监听已就绪，现在可以登录微信，并在手机上确认。'
const CORE_DATABASE = /^(?:session|contact|message_.+)\.db$/i
const SQLITE_HEADER = Buffer.from('SQLite format 3\0')
const SAFE_STAGES = new Set(['authorized', 'attaching', 'ready', 'captured', 'stopping', 'detaching', 'detached',
  'attach_denied', 'attach_timeout', 'wrong_target', 'hardware_unavailable', 'unsupported_architecture',
  'continue_failed', 'unexpected_stop', 'target_exited', 'timeout', 'cancelled', 'capture_error',
  'detach_failed', 'administrator_required'])

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'` }
function assertActive(signal?: AbortSignal): void { if (signal?.aborted) throw new CaptureError(CANCELLED) }
function pause(milliseconds: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, milliseconds)) }
function run(file: string, args: string[], timeout = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(new CaptureError('RUNTIME_COMMAND_FAILED'))
      else resolve(stdout.trim())
    })
  })
}
function derive(password: Buffer, salt: Buffer, iterations: number): Promise<Buffer> {
  return new Promise((resolve, reject) => pbkdf2(password, salt, iterations, 32, 'sha512', (error, key) => error ? reject(error) : resolve(key)))
}

/** SQLCipher 4 default first-page authentication, adapted from wcdb-key-tool.
 * See THIRD_PARTY_NOTICES/WcdbKeyTool. No page contents or keys are logged. */
export async function verifyLoginCapturePage(password: Buffer, page: Buffer): Promise<boolean> {
  if (password.length !== 32 || page.length !== 4096 || page.subarray(0, 16).equals(SQLITE_HEADER)) return false
  const salt = page.subarray(0, 16)
  const key = await derive(password, salt, 256000)
  let macKey: Buffer | undefined
  try {
    macKey = await derive(key, Buffer.from(salt.map(value => value ^ 0x3a)), 2)
    const pageNumber = Buffer.alloc(4)
    pageNumber.writeUInt32LE(1)
    const digest = createHmac('sha512', macKey).update(page.subarray(16, 4032)).update(pageNumber).digest()
    return timingSafeEqual(digest, page.subarray(4032))
  } finally {
    key.fill(0)
    macKey?.fill(0)
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try { const details = await fs.lstat(path); return details.isDirectory() && !details.isSymbolicLink() } catch { return false }
}

/** Resolve account boundaries first; salts never substitute for per-account validation. */
export async function findLoginCaptureAccounts(dbPath: string, wxid?: string): Promise<Account[]> {
  const root = resolve(String(dbPath || '').trim())
  if (!String(dbPath || '').trim() || !await isDirectory(root)) throw new CaptureError('请选择存在的微信数据目录。')
  const selected = String(wxid || '').trim()
  if (selected && (selected.includes('/') || selected.includes('\\') || selected === '.' || selected === '..')) {
    throw new CaptureError('微信账号标识无效，请重新选择账号。')
  }
  const matches = (name: string) => !selected || name === selected || name.startsWith(`${selected}_`)
  if (basename(root).toLowerCase() === 'db_storage') {
    const name = basename(dirname(root))
    if (!matches(name)) throw new CaptureError('所选微信账号与数据库目录不一致。')
    return [{ directory: root, wxid: name }]
  }
  if (await isDirectory(join(root, 'db_storage'))) {
    const name = basename(root)
    if (!matches(name)) throw new CaptureError('所选微信账号与数据库目录不一致。')
    return [{ directory: join(root, 'db_storage'), wxid: name }]
  }
  const accounts: Account[] = []
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !matches(entry.name)) continue
    const directory = join(root, entry.name, 'db_storage')
    if (await isDirectory(directory)) accounts.push({ directory, wxid: entry.name })
  }
  if (!accounts.length) throw new CaptureError('没有找到所选账号的 db_storage，请先选择已有微信数据的账号目录。')
  if (selected && accounts.length !== 1) throw new CaptureError('匹配到多个账号目录，请选择具体账号目录后再获取。')
  if (accounts.length > 20) throw new CaptureError('账号目录过多，请选择具体账号后再获取。')
  return accounts.sort((left, right) => left.directory.localeCompare(right.directory))
}

async function readPages(account: Account, signal?: AbortSignal): Promise<{ page: Buffer; core: boolean }[]> {
  const pages: { page: Buffer; core: boolean }[] = []
  const directories = [{ path: account.directory, depth: 0 }]
  while (directories.length) {
    assertActive(signal)
    const current = directories.pop()!
    for (const entry of await fs.readdir(current.path, { withFileTypes: true })) {
      assertActive(signal)
      const path = join(current.path, entry.name)
      if (entry.isSymbolicLink()) throw new CaptureError('数据库目录含符号链接，请选择实际账号目录后再试。')
      if (entry.isDirectory()) {
        if (current.depth >= 8) throw new CaptureError('数据库目录结构过深，请选择账号的 db_storage 目录。')
        directories.push({ path, depth: current.depth + 1 })
      } else if (/\.db$/i.test(entry.name)) {
        const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          const details = await file.stat()
          if (!details.isFile()) throw new CaptureError('数据库目录中存在非普通数据库文件。')
          const buffer = Buffer.alloc(4096)
          const { bytesRead } = await file.read(buffer, 0, 4096, 0)
          const page = buffer.subarray(0, bytesRead)
          if (page.length >= 16 && page.subarray(0, 16).equals(SQLITE_HEADER)) continue
          pages.push({ page, core: CORE_DATABASE.test(entry.name) })
          if (pages.length > 4096) throw new CaptureError('数据库文件过多，请选择具体账号后重试。')
        } finally { await file.close() }
      }
    }
  }
  return pages
}

async function readPrivateJson(path: string): Promise<unknown> {
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const details = await file.stat()
    if (!details.isFile() || (details.mode & 0o777) !== 0o600 || details.size > 65536) throw new CaptureError('INVALID_PRIVATE_FILE')
    const data = await file.readFile('utf8')
    if (data.length > 65536) throw new CaptureError('INVALID_PRIVATE_FILE')
    return JSON.parse(data)
  } finally { await file.close() }
}

function asProgress(value: unknown): Progress | null {
  if (!value || typeof value !== 'object') return null
  const data = value as Progress
  if (!SAFE_STAGES.has(data.stage)) return null
  return { stage: data.stage, captured: data.captured === true, detached: data.detached === true, finished: data.finished === true }
}

export class WechatLoginCaptureService {
  private busy = false
  private unsafePid: number | null = null
  private readonly timings: Timings

  constructor(timings: Partial<Timings> = {}) {
    this.timings = { authorization: 90_000, monitor: 300_000, cleanup: 30_000, poll: 200, ...timings }
  }

  protected resourceDirectories(): string[] {
    return app.isPackaged
      ? [join(process.resourcesPath, 'resources', 'macos', 'login-capture'), join(process.resourcesPath, 'macos', 'login-capture')]
      : [join(app.getAppPath(), 'resources', 'macos', 'login-capture'), join(process.cwd(), 'resources', 'macos', 'login-capture')]
  }

  protected async runtimeDetails(): Promise<{ directory: string; python: string }> {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new CaptureError('登录捕获目前仅支持 Apple Silicon Mac。')
    let directory: string | undefined
    for (const path of this.resourceDirectories()) {
      try {
        await Promise.all(['supervisor.py', 'wechat_lldb_capture.py', 'wechat_key_verify.py'].map(name => fs.access(join(path, name))))
        directory = path
        break
      } catch { /* Try the other packaged resource layout. */ }
    }
    if (!directory) throw new CaptureError('登录捕获组件缺失，请重新安装应用。')
    try {
      const lldb = await run('/usr/bin/xcrun', ['--find', 'lldb'])
      if (!lldb.startsWith('/')) throw new CaptureError('NO_LLDB')
      const version = await run('/usr/bin/python3', ['-B', '-c', 'import sys; print(int(sys.version_info >= (3, 9)))'])
      if (version !== '1') throw new CaptureError('OLD_PYTHON')
    } catch { throw new CaptureError('需要可用的 Xcode Command Line Tools（LLDB 和 Python 3.9+）。请安装后重试。') }
    return { directory, python: '/usr/bin/python3' }
  }

  async checkRuntime(): Promise<{ ready: boolean; error?: string }> {
    try { await this.runtimeDetails(); return { ready: true } } catch (error) {
      return { ready: false, error: error instanceof Error ? error.message : '无法检测登录捕获运行环境。' }
    }
  }

  protected async findTarget(): Promise<Target> {
    const output = await run('/bin/ps', ['-axo', 'pid=,uid=,comm='])
    const uid = process.getuid?.()
    const targets: { pid: number; executable: string }[] = []
    for (const line of output.split(/\r?\n/)) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)
      if (!match || Number(match[2]) !== uid || !/\.app\/Contents\/MacOS\/WeChat$/.test(match[3].trim())) continue
      const executable = await fs.realpath(match[3].trim())
      if (!executable.endsWith('/Contents/MacOS/WeChat')) continue
      targets.push({ pid: Number(match[1]), executable })
    }
    if (!targets.length) throw new CaptureError('请先打开微信，退出账号并停留在登录界面。')
    if (targets.length !== 1) throw new CaptureError('检测到多个微信主进程，请保留一个微信窗口后重试。')
    if (this.unsafePid === targets[0].pid) throw new CaptureError(CLEANUP_FAILED)
    const startTime = await run('/bin/ps', ['-p', String(targets[0].pid), '-o', 'lstart='])
    if (!startTime) throw new CaptureError('微信进程已退出，请重新打开后再试。')
    return { ...targets[0], startTime }
  }

  protected authorize(runtime: { directory: string; python: string }, requestPath: string): Authorization {
    const command = [runtime.python, '-B', join(runtime.directory, 'supervisor.py'), requestPath].map(shellQuote).join(' ')
    const script = ['try', 'with timeout of 480 seconds', `do shell script ${JSON.stringify(command)} with administrator privileges`,
      'end timeout', 'return "OK"', 'on error number errorNumber', 'return "ERR:" & errorNumber', 'end try']
    let child: ChildProcess
    const done = new Promise<string>(resolve => {
      child = execFile('/usr/bin/osascript', script.flatMap(line => ['-e', line]),
        { timeout: 480_000, maxBuffer: 1024, encoding: 'utf8' }, (_error, stdout) => resolve(String(stdout || '').trim()))
    })
    return { child: child!, done }
  }

  async capture(options: WechatLoginCaptureOptions): Promise<WechatLoginCaptureResult> {
    if (this.busy) return { success: false, error: '已有登录捕获正在运行或结束，请稍后再试。' }
    this.busy = true
    let directory: string | undefined
    let marker: string | undefined
    let target: Target | undefined
    let authorization: Authorization | undefined
    let authorizationDone = false
    let completed = false
    let authorized = false
    let completion: Progress | null = null
    let password: Buffer | undefined
    let lastStatus = ''
    let outcome: WechatLoginCaptureResult = { success: false }
    const status = (text: string, level = 0) => {
      if (text === lastStatus) return
      lastStatus = text
      try { options.onStatus?.(text, level) } catch { /* UI listeners cannot break cleanup. */ }
    }
    const cancel = () => { if (marker) void fs.unlink(marker).catch(() => undefined) }
    options.signal?.addEventListener('abort', cancel)
    try {
      assertActive(options.signal)
      const runtime = await this.runtimeDetails()
      const accounts = await findLoginCaptureAccounts(options.dbPath, options.wxid)
      const salts = new Set<string>()
      for (const account of accounts) {
        const pages = await readPages(account, options.signal)
        if (!pages.some(item => item.core && item.page.length === 4096)) continue
        for (const { page } of pages) if (page.length === 4096) salts.add(page.subarray(0, 16).toString('hex'))
      }
      if (!salts.size) throw new CaptureError('所选目录没有可验证的加密微信数据库，请先选择已有数据的账号。')
      target = await this.findTarget()
      assertActive(options.signal)
      directory = await fs.mkdtemp(join(tmpdir(), 'notewake-login-'))
      await fs.chmod(directory, 0o700)
      marker = join(directory, 'active')
      const requestId = randomUUID()
      await fs.writeFile(marker, requestId, { mode: 0o600, flag: 'wx' })
      const requestPath = join(directory, 'request.json')
      await fs.writeFile(requestPath, JSON.stringify({ ...target, timeoutSeconds: Math.min(300, Math.max(1, Math.ceil(this.timings.monitor / 1000))),
        requestId, authorizationExpiresAt: Date.now() + this.timings.authorization, salts: [...salts] }), { mode: 0o600, flag: 'wx' })
      assertActive(options.signal)
      status('请完成 macOS 管理员授权；看到“监听已就绪”后再登录微信。')
      const started = Date.now()
      let authorizedAt = 0
      let readyAt = 0
      let returned = ''
      assertActive(options.signal)
      authorization = this.authorize(runtime, requestPath)
      void authorization.done.then(value => { authorizationDone = true; returned = value })
      while (true) {
        assertActive(options.signal)
        let progress: Progress | null = null
        try { progress = asProgress(await readPrivateJson(join(directory, 'progress.json'))) } catch { /* Not published yet. */ }
        try { completion = asProgress(await readPrivateJson(join(directory, 'completion.json'))) } catch { /* Supervisor still running. */ }
        if (progress || completion) {
          authorized = true
          authorizedAt ||= Date.now()
        }
        if (progress?.stage === 'ready') { readyAt ||= Date.now(); status(READY) }
        else if (progress?.stage === 'authorized' || progress?.stage === 'attaching') status('授权已完成，正在安装微信登录监听，请暂时不要点击登录。')
        else if (progress?.stage === 'captured' || progress?.stage === 'stopping' || progress?.stage === 'detaching') status('已结束等待，正在安全移除微信登录监听。')
        if (completion?.finished) { completed = true; break }
        if (authorizationDone) {
          // A supervisor writes completion before returning to AppleScript.
          try { completion = asProgress(await readPrivateJson(join(directory, 'completion.json'))) } catch { /* No acknowledged completion. */ }
          if (completion?.finished) { completed = true; break }
          throw new CaptureError(returned === 'ERR:-128' ? '已取消 macOS 管理员授权。' : authorized ? CLEANUP_FAILED : '管理员授权未完成，登录监听尚未启动。')
        }
        if (!authorized && Date.now() - started >= this.timings.authorization) throw new CaptureError('等待 macOS 管理员授权超时，登录监听尚未启动。请完成系统授权后重试。')
        if (authorized && !readyAt && Date.now() - authorizedAt > 45_000) throw new CaptureError(CLEANUP_FAILED)
        if (readyAt && Date.now() - readyAt > this.timings.monitor + this.timings.cleanup) throw new CaptureError(CLEANUP_FAILED)
        await pause(this.timings.poll)
      }
      assertActive(options.signal)
      if (!completion || completion.stage !== 'detached' || !completion.captured || !completion.detached) {
        throw new CaptureError(this.captureError(completion?.stage))
      }
      if (await fs.readFile(marker, 'utf8') !== requestId) throw new CaptureError(CANCELLED)
      const value = await readPrivateJson(join(directory, 'candidate.json')) as { passphrase?: unknown }
      if (!value || typeof value.passphrase !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value.passphrase) || Object.keys(value).length !== 1) {
        throw new CaptureError('捕获结果格式无效，没有保存新的密钥。')
      }
      password = Buffer.from(value.passphrase, 'hex')
      // The candidate is needed only in memory after the supervisor has exited.
      try { await fs.unlink(join(directory, 'candidate.json')) } catch { throw new CaptureError(FILE_CLEANUP_FAILED) }
      status('监听已安全结束，正在逐库验证新捕获的密钥。')
      const matches: Account[] = []
      for (const account of accounts) {
        const pages = await readPages(account, options.signal)
        if (!pages.length || !pages.some(item => item.core)) continue
        let verified = 0
        for (const { page } of pages) {
          assertActive(options.signal)
          if (await verifyLoginCapturePage(password, page)) verified += 1
          assertActive(options.signal)
        }
        if (verified === pages.length) matches.push(account)
      }
      assertActive(options.signal)
      if (await fs.readFile(marker, 'utf8') !== requestId) throw new CaptureError(CANCELLED)
      if (matches.length !== 1) throw new CaptureError(matches.length ? '候选通过多个账号目录，请选择具体账号后再获取。' : '新捕获的候选未通过所选账号全部数据库验证，没有更改现有连接配置。')
      const key = password.toString('hex')
      status('登录捕获与全部数据库验证通过。', 1)
      outcome = { success: true, key, ...(matches[0].wxid ? { validatedWxid: matches[0].wxid } : {}) }
    } catch (error) {
      const message = options.signal?.aborted ? CANCELLED : error instanceof CaptureError ? error.message : '登录捕获没有完成，请重试。'
      if (target && (message === CLEANUP_FAILED || completion?.stage === 'detach_failed')) this.unsafePid = target.pid
      // Only controlled messages are surfaced. Native errors can include account paths.
      const safe = /(?:密钥|登录|微信|账号|数据库|目录|授权|监听|Mac|Xcode|组件|LLDB)/.test(message) && !/[0-9a-f]{32,}/i.test(message)
      outcome = { success: false, error: safe ? message : '登录捕获没有完成，请重试。' }
    } finally {
      options.signal?.removeEventListener('abort', cancel)
      if (marker) {
        try { await fs.unlink(marker) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            // If unlink is denied, invalidate the token before waiting for root.
            await fs.writeFile(marker, '').catch(() => undefined)
            outcome = { success: false, error: FILE_CLEANUP_FAILED }
          }
        }
      }
      // Recheck startup after invalidating the marker to close the abort/authorize race.
      if (authorization && !authorized && directory) {
        try { authorized = !!asProgress(await readPrivateJson(join(directory, 'progress.json'))) } catch { /* No privileged helper has started. */ }
      }
      if (authorization && authorized && !completed) {
        status('正在取消登录监听并等待安全结束。')
        const cleanupDeadline = Date.now() + this.timings.cleanup
        while (Date.now() < cleanupDeadline) {
          try {
            completion = asProgress(await readPrivateJson(join(directory!, 'completion.json')))
            if (completion?.finished) { completed = true; break }
          } catch { /* Wait for the privileged supervisor to acknowledge cancellation. */ }
          await pause(this.timings.poll)
        }
        if (!completion?.detached && target) {
          this.unsafePid = target.pid
          status(CLEANUP_FAILED, 2)
          outcome = { success: false, error: CLEANUP_FAILED }
        }
      }
      // Terminate only the AppleScript process we created. The root supervisor
      // observes the missing marker and handles its own debugger process group.
      if (authorization && !authorizationDone) authorization.child.kill('SIGTERM')
      password?.fill(0)
      if (directory) {
        try { await fs.rm(directory, { recursive: true, force: true }) } catch {
          outcome = { success: false, error: FILE_CLEANUP_FAILED }
          status(FILE_CLEANUP_FAILED, 2)
        }
      }
      // Cleanup awaits can outlive the renderer/request. Never return a late key.
      if (options.signal?.aborted && outcome.success) outcome = { success: false, error: CANCELLED }
      this.busy = false
    }
    return outcome
  }

  private captureError(stage?: string): string {
    switch (stage) {
      case 'cancelled': return CANCELLED
      case 'timeout': return '等待登录超时，请停留在微信登录界面，重新获取并在监听就绪后登录。'
      case 'attach_denied': return '管理员授权已完成，但 macOS 拒绝附加微信。应用不会修改微信签名或系统保护，请使用已有密钥。'
      case 'wrong_target': return '微信进程在授权期间发生变化，请保持当前微信窗口并重试。'
      case 'unsupported_architecture': return '此微信进程不是 arm64，登录捕获目前不支持 Rosetta 版本。'
      case 'hardware_unavailable': return '无法安装硬件监听，本次获取已停止，请使用已有密钥。'
      case 'target_exited': return '微信进程已退出，请重新打开并停留在登录界面后重试。'
      case 'attach_timeout': return '附加微信超时，请重新打开微信后重试。'
      case 'detach_failed': return CLEANUP_FAILED
      default: return '微信登录监听未能正常完成，没有保存新的密钥。'
    }
  }
}

export const wechatLoginCaptureService = new WechatLoginCaptureService()
