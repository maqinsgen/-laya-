import { app } from 'electron'
import { basename, dirname, join } from 'path'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { execFile, execSync, spawn, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import crypto from 'crypto'
import { homedir, tmpdir } from 'os'
import { setTimeout as wait } from 'timers/promises'
import { WECHAT_HEX_SCAN_PY, WechatHexCandidateStream } from './wechatMemoryScan'
import { WECHAT_AUTHORIZATION_TIMEOUT_MS, parseWechatMemoryProgress, formatWechatMemoryProgress, isWechatAuthorizationCancelled, type WechatMemoryProgress } from '../../src/shared/wechatKeyAcquisition'
import { MAC_WECHAT_SECURITY_MESSAGE, parseMacSipStatus, redactWechatKey } from '../../src/shared/wechatConnection'

const execFileAsync = promisify(execFile)
const MAC_KEY_DEBUG = process.env.CIPHERTALK_MAC_KEY_DEBUG === '1'

function logMacKey(level: 'log' | 'warn' | 'error', ...args: any[]): void {
  if (!MAC_KEY_DEBUG) return
  console[level](...args.map(value => redactWechatKey(value)))
}

type DbKeyResult = {
  success: boolean
  key?: string
  error?: string
  logs?: string[]
  candidates?: string[]
}

type DbKeyPreflightResult = {
  success: boolean
  error?: string
}

const SIP_DB_KEY_ERROR = MAC_WECHAT_SECURITY_MESSAGE
const WECHAT_CRASH_ERROR = '微信在密钥捕获期间崩溃了。微信 4.1 刚启动或被强制重启时，调试器下断点会直接退出。请先手动打开微信并完成登录，确认能正常收发消息后再获取密钥；若仍无结果，在微信里退出登录后再登录一次，不要强制退出微信进程。'
const ALLOW_BREAKPOINT_HELPER = process.env.CIPHERTALK_ALLOW_WX_BREAKPOINT === '1'

const MIN_ATTACH_UPTIME_SECONDS = 8
// The elevated parent outlives osascript on some macOS versions. Its marker and
// deadline ensure only this request's child is stopped, without global pkill.
const HELPER_WATCHDOG_PY = `import os, subprocess, sys, time
helper, pid, wait_ms, marker = sys.argv[1:5]
deadline = time.monotonic() + float(wait_ms) / 1000 + 5
if not os.path.exists(marker):
    sys.exit(3)
child = subprocess.Popen([helper, pid, wait_ms], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
try:
    while True:
        try:
            output, _ = child.communicate(timeout=0.2)
            sys.stdout.buffer.write(output)
            sys.exit(child.returncode)
        except subprocess.TimeoutExpired:
            if not os.path.exists(marker) or time.monotonic() >= deadline:
                child.terminate()
                try:
                    child.communicate(timeout=2)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.communicate()
                sys.exit(3)
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
`

function parsePsEtime(raw: string): number | null {
  const match = String(raw || '').trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/)
  if (!match) return null
  const days = Number(match[1] || 0)
  const hours = Number(match[2] || 0)
  const minutes = Number(match[3] || 0)
  const seconds = Number(match[4] || 0)
  if (![days, hours, minutes, seconds].every(Number.isFinite)) return null
  return days * 86400 + hours * 3600 + minutes * 60 + seconds
}

type ImageKeyResult = {
  success: boolean
  xorKey?: number
  aesKey?: string
  error?: string
}

export class WxKeyServiceMac {
  private koffi: any = null
  private libSystem: any = null
  private machTaskSelf: any = null
  private taskForPid: any = null
  private machVmRegion: any = null
  private machVmReadOverwrite: any = null
  private machPortDeallocate: any = null
  private needsElevation = false
  private helperChild: ChildProcess | null = null
  private helperAbort = false
  private dbKeyAbort: AbortController | null = null

  private getResourceDirs(): string[] {
    if (app.isPackaged) {
      return [
        join(process.resourcesPath, 'resources', 'macos'),
        join(process.resourcesPath, 'macos')
      ]
    }

    return [
      join(app.getAppPath(), 'resources', 'macos'),
      join(process.cwd(), 'resources', 'macos')
    ]
  }

  private resolveResource(name: string): string {
    for (const dir of this.getResourceDirs()) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }

    throw new Error(`${name} not found`)
  }

  private getHelperPath(): string {
    if (process.env.WX_KEY_HELPER_PATH && existsSync(process.env.WX_KEY_HELPER_PATH)) {
      return process.env.WX_KEY_HELPER_PATH
    }
    return this.resolveResource('xkey_helper')
  }

  private getImageScanHelperPath(): string {
    if (process.env.IMAGE_SCAN_HELPER_PATH && existsSync(process.env.IMAGE_SCAN_HELPER_PATH)) {
      return process.env.IMAGE_SCAN_HELPER_PATH
    }
    return this.resolveResource('image_scan_helper')
  }

  async checkSipStatus(): Promise<{ enabled: boolean; error?: string }> {
    try {
      const { stdout } = await execFileAsync('/usr/bin/csrutil', ['status'], { timeout: 5_000 })
      const status = parseMacSipStatus(stdout)
      return status === 'unknown' ? { enabled: false, error: '无法识别系统保护状态' } : { enabled: status === 'enabled' }
    } catch (e: any) {
      return { enabled: false, error: redactWechatKey(e) }
    }
  }

  async checkDbKeyPreconditions(): Promise<DbKeyPreflightResult> {
    const sipStatus = await this.checkSipStatus()
    if (sipStatus.error) {
      return {
        success: false,
        error: `无法检测 SIP 状态，为避免异常已停止获取密钥：${sipStatus.error}`
      }
    }
    if (sipStatus.enabled) {
      return { success: false, error: SIP_DB_KEY_ERROR }
    }
    return { success: true }
  }

  isWeChatRunning(): boolean {
    return this.getWeChatPid() !== null
  }

  getWeChatPid(): number | null {
    try {
      const exact = execSync('/usr/bin/pgrep -x WeChat', { encoding: 'utf8', timeout: 5_000 })
      const ids = exact.split(/\r?\n/).map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0)
      if (ids.length > 0) return Math.max(...ids)
    } catch {
      // ignore
    }

    try {
      const fuzzy = execSync('/usr/bin/pgrep -f WeChat.app/Contents/MacOS/WeChat', { encoding: 'utf8', timeout: 5_000 })
      const ids = fuzzy.split(/\r?\n/).map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0)
      if (ids.length > 0) return Math.max(...ids)
    } catch {
      // ignore
    }

    try {
      const output = execSync('/bin/ps -A -o pid,comm,command', { encoding: 'utf8', timeout: 5_000 })
      const lines = output.split(/\r?\n/).slice(1)
      const candidates: number[] = []

      for (const line of lines) {
        const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/)
        if (!match) continue

        const pid = parseInt(match[1], 10)
        const comm = match[2]
        const command = match[3]
        const isMain = comm === 'WeChat' || command.includes('/Contents/MacOS/WeChat')
        const isHelper = command.includes('WeChatAppEx') || command.includes('Helper') || command.includes('crashpad_handler')
        if (isMain && !isHelper) {
          candidates.push(pid)
        }
      }

      if (candidates.length > 0) {
        return Math.max(...candidates)
      }
    } catch {
      // ignore
    }

    return null
  }

  killWeChat(): boolean {
    try {
      execSync('/usr/bin/pkill -x WeChat', { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }

  async waitForWeChatExit(maxWaitSeconds = 15): Promise<boolean> {
    for (let i = 0; i < maxWaitSeconds * 2; i++) {
      if (!this.isWeChatRunning()) {
        return true
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    return !this.isWeChatRunning()
  }

  async launchWeChat(customPath?: string): Promise<boolean> {
    try {
      if (customPath && existsSync(customPath)) {
        await execFileAsync('/usr/bin/open', [customPath])
      } else {
        await execFileAsync('/usr/bin/open', ['-a', 'WeChat'])
      }
      await new Promise(resolve => setTimeout(resolve, 1500))
      return this.isWeChatRunning()
    } catch {
      return false
    }
  }

  async waitForWeChatWindow(maxWaitSeconds = 15): Promise<boolean> {
    for (let i = 0; i < maxWaitSeconds * 2; i++) {
      if (this.isWeChatRunning()) {
        return true
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    return false
  }

  getWeChatUptimeSeconds(pid?: number | null): number | null {
    const target = pid ?? this.getWeChatPid()
    if (!target) return null
    try {
      const raw = execSync(`/bin/ps -p ${target} -o etime=`, { encoding: 'utf8', timeout: 5_000 })
      return parsePsEtime(raw)
    } catch {
      return null
    }
  }

  async scanHexDbKeyCandidates(
    onStatus?: (message: string, level: number) => void,
    signal?: AbortSignal,
    timeoutMs = 90_000
  ): Promise<string[]> {
    signal?.throwIfAborted()
    const pid = this.getWeChatPid()
    if (!pid) return []

    const local = await this.scanHexKeysWithMach(pid, onStatus, signal, Math.min(timeoutMs, 30_000))
    signal?.throwIfAborted()
    if (local !== null) return local

    onStatus?.('等待 macOS 管理员授权：请在系统弹窗中完成授权。授权后才开始计算扫描时间。', 0)
    try {
      return await this.scanHexKeysElevated(pid, signal, timeoutMs, onStatus)
    } catch (e: any) {
      signal?.throwIfAborted()
      const msg = `${e?.message || e}`
      if (msg === '已取消管理员授权' || isWechatAuthorizationCancelled(msg)) {
        throw new Error('已取消管理员授权')
      }
      logMacKey('warn', '[WxKeyServiceMac] elevated hex scan failed:', msg)
      if (msg.includes('ERROR:ATTACH')) throw new Error('系统仍阻止读取微信进程。请手动填入已有密钥，或先使用其他信息来源。')
      throw new Error(`本机读取组件执行失败：${redactWechatKey(e)}`)
    }
  }

  private rankHexKeys(counts: Map<string, number>, limit = 80): string[] {
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([key]) => key)
  }

  private async scanHexKeysWithMach(
    pid: number,
    onStatus?: (message: string, level: number) => void,
    signal?: AbortSignal,
    timeoutMs = 30_000
  ): Promise<string[] | null> {
    if (!this.ensureMachApis()) return null

    const VM_PROT_READ = 0x1
    const VM_PROT_WRITE = 0x2
    const VM_REGION_BASIC_INFO_64 = 9
    const VM_REGION_BASIC_INFO_COUNT_64 = 9
    const KERN_SUCCESS = 0
    const CHUNK = 4 * 1024 * 1024
    const deadline = Date.now() + timeoutMs
    let scannedBytes = 0
    let lastProgress = 0

    const selfTask = this.machTaskSelf()
    // dispose() may clear instance fields while the scan yields for cancellation.
    const releasePort = this.machPortDeallocate
    const taskBuf = Buffer.alloc(4)
    const attachKr = this.taskForPid(selfTask, pid, taskBuf)
    const task = taskBuf.readUInt32LE(0)
    if (attachKr !== KERN_SUCCESS || !task) {
      logMacKey('warn', `[WxKeyServiceMac] hex scan task_for_pid failed: kr=${attachKr}`)
      return null
    }

    const counts = new Map<string, number>()
    try {
      let address = 0
      let regionCount = 0
      const regions: Array<{ base: number; size: number }> = []
      let mappedRegions = 0
      onStatus?.('正在定位可读取的内存区，优先检查较小区域…', 0)
      while (address < 0x7FFFFFFFFFFF) {
        signal?.throwIfAborted()
        if (Date.now() >= deadline) break
        if (++mappedRegions % 64 === 0) {
          await wait(0, undefined, { signal })
          signal?.throwIfAborted()
          if (Date.now() >= deadline) break
        }
        const addrBuf = Buffer.alloc(8)
        addrBuf.writeBigUInt64LE(BigInt(address), 0)
        const sizeBuf = Buffer.alloc(8)
        const infoBuf = Buffer.alloc(64)
        const countBuf = Buffer.alloc(4)
        countBuf.writeUInt32LE(VM_REGION_BASIC_INFO_COUNT_64, 0)
        const objectBuf = Buffer.alloc(4)
        const kr = this.machVmRegion(task, addrBuf, sizeBuf, VM_REGION_BASIC_INFO_64, infoBuf, countBuf, objectBuf)
        const objectName = objectBuf.readUInt32LE(0)
        if (objectName) {
          try { releasePort(selfTask, objectName) } catch { /* ignore */ }
        }
        if (kr !== KERN_SUCCESS) {
          if (kr !== 1) throw new Error('微信内存区域枚举中断，请确认微信仍在运行后重试。')
          break // KERN_INVALID_ADDRESS is the end of the memory map.
        }
        const base = Number(addrBuf.readBigUInt64LE(0))
        const size = Number(sizeBuf.readBigUInt64LE(0))
        const protection = infoBuf.readInt32LE(0)
        if ((protection & VM_PROT_READ) !== 0 && (protection & VM_PROT_WRITE) !== 0 && size > 0) {
          regions.push({ base, size })
        }
        const next = base + size
        if (!Number.isSafeInteger(next) || next <= address) throw new Error('微信内存区域信息无效，请重试。')
        address = next
      }
      // Large reserved heaps must not consume the entire deadline before small
      // key-bearing allocations later in the address space can be inspected.
      regions.sort((a, b) => a.size - b.size || a.base - b.base)
      scan: for (const { base, size } of regions) {
        signal?.throwIfAborted()
        if (Date.now() >= deadline) break
        regionCount += 1
        let offset = 0
        let candidates = new WechatHexCandidateStream(counts)
        while (offset < size) {
          // Allow the cancel IPC to run between bounded native reads.
          await wait(0, undefined, { signal })
          if (Date.now() >= deadline) break scan
          const chunkSize = Math.min(CHUNK, size - offset)
          const chunk = Buffer.alloc(chunkSize)
          const outSizeBuf = Buffer.alloc(8)
          const readKr = this.machVmReadOverwrite(task, base + offset, chunkSize, chunk, outSizeBuf)
          const bytesRead = Number(outSizeBuf.readBigUInt64LE(0))
          offset += chunkSize
          if (readKr !== KERN_SUCCESS || bytesRead <= 0 || bytesRead > chunkSize) {
            candidates = new WechatHexCandidateStream(counts)
            continue
          }
          const current: Buffer = chunk.subarray(0, bytesRead)
          candidates.feed(current, offset >= size && bytesRead === chunkSize)
          if (bytesRead < chunkSize) candidates = new WechatHexCandidateStream(counts)
          scannedBytes += bytesRead
          if (Date.now() - lastProgress >= 1000) {
            onStatus?.(`正在只读扫描：${regionCount} 个内存区 · ${Math.round(scannedBytes / 1_048_576)} MB · ${counts.size} 个候选`, 0)
            lastProgress = Date.now()
          }
        }
      }
      const timedOut = Date.now() >= deadline
      onStatus?.(`${timedOut ? '扫描时间已到，保留已发现候选' : '扫描完成'}：${regionCount} 个内存区 · ${Math.round(scannedBytes / 1_048_576)} MB · ${counts.size} 个候选`, 0)
      if (timedOut && counts.size === 0) throw new Error('已获得读取权限，但本次内存扫描未在时限内找到候选密钥。可关闭不需要的微信小程序后重试，或使用已有密钥。')
    } finally {
      try { releasePort(selfTask, task) } catch { /* ignore */ }
    }

    return this.rankHexKeys(counts)
  }

  private async scanHexKeysElevated(
    pid: number, signal?: AbortSignal, timeoutMs = 90_000,
    onStatus?: (message: string, level: number) => void,
  ): Promise<string[]> {
    signal?.throwIfAborted()
    const dir = mkdtempSync(join(tmpdir(), 'ct-wxkey-'))
    const scriptPath = join(dir, 'scan_hex_keys.py')
    const markerPath = join(dir, 'active')
    const progressPath = join(dir, 'progress.json')
    const controller = new AbortController()
    const cancel = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', cancel, { once: true })
    const startedAt = Date.now()
    let authorizedAt: number | null = null
    let progress: WechatMemoryProgress | null = null
    let lastStatus = ''
    let phaseError: Error | null = null
    const updateProgress = () => {
      try {
        progress = parseWechatMemoryProgress(JSON.parse(readFileSync(progressPath, 'utf8')))
      } catch { /* The helper has not started, or is replacing its progress file. */ }
      if (progress) {
        authorizedAt ??= Date.now()
        const status = formatWechatMemoryProgress(progress)
        if (status !== lastStatus) { onStatus?.(status, 0); lastStatus = status }
      }
      const now = Date.now()
      if (authorizedAt === null && now - startedAt >= WECHAT_AUTHORIZATION_TIMEOUT_MS) {
        phaseError = new Error('等待 macOS 管理员授权超时，尚未开始内存扫描。请完成系统授权后重试；打开聊天不会解决此阶段的问题。')
        controller.abort(phaseError)
      } else if (authorizedAt !== null && now - authorizedAt >= timeoutMs + 5_000) {
        phaseError = new Error('管理员授权已完成，但内存扫描未按时结束。已停止本次读取，请稍后重试或填写已有密钥。')
        controller.abort(phaseError)
      }
    }
    let progressTimer: ReturnType<typeof setInterval> | undefined
    try {
      writeFileSync(scriptPath, WECHAT_HEX_SCAN_PY, { encoding: 'utf8', mode: 0o600 })
      writeFileSync(markerPath, '', { mode: 0o600 })
      signal?.throwIfAborted()
      const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000))
      const totalTimeoutMs = WECHAT_AUTHORIZATION_TIMEOUT_MS + timeoutMs + 10_000
      const scriptLines = [
        `set cmd to "/usr/bin/python3 " & quoted form of ${JSON.stringify(scriptPath)} & " ${pid} " & quoted form of ${JSON.stringify(markerPath)} & " ${timeoutSeconds} " & quoted form of ${JSON.stringify(progressPath)}`,
        'try',
        `with timeout of ${Math.ceil(totalTimeoutMs / 1000)} seconds`,
        'set outText to do shell script cmd with administrator privileges without altering line endings',
        'end timeout',
        'return "WF_OK::" & outText',
        'on error errMsg number errNum',
        'return "WF_ERR::" & errNum & "::" & errMsg',
        'end try',
      ]
      progressTimer = setInterval(updateProgress, 250)
      const { stdout } = await execFileAsync('/usr/bin/osascript', scriptLines.flatMap(line => ['-e', line]), {
        timeout: totalTimeoutMs, signal: controller.signal, maxBuffer: 4 * 1024 * 1024,
      })
      signal?.throwIfAborted()
      updateProgress()
      if (phaseError) throw phaseError
      const completedProgress = progress as WechatMemoryProgress | null
      const text = String(stdout || '').trim()
      if (isWechatAuthorizationCancelled(text)) throw new Error('已取消管理员授权')
      if (completedProgress?.errorCode === 'ATTACH_DENIED' || text.includes('ERROR:ATTACH')) {
        throw new Error('管理员授权已完成，但系统仍阻止读取微信进程。可使用已有密钥；应用不会更改系统安全保护。')
      }
      if (text.startsWith('WF_ERR::') || completedProgress?.stage === 'error') throw new Error('本机读取组件没有正常完成，请重试；未保存新的微信连接配置。')
      const payload = text.startsWith('WF_OK::') ? text.slice('WF_OK::'.length) : text
      // AppleScript normally converts LF to bare CR; tolerate all three styles.
      const keys = [...new Set(payload.split(/\r\n?|\n/).map(line => line.trim().toLowerCase()).filter(line => /^[0-9a-f]{64}$/.test(line)))].slice(0, 80)
      if ((completedProgress?.candidates || 0) > 0 && !keys.length) throw new Error('扫描已找到候选，但读取组件返回的结果无法解析。请重试；现有连接配置会保留。')
      if (completedProgress?.stage === 'timeout' && !keys.length) throw new Error('已获得读取权限，但扫描时限内未找到候选密钥。可关闭不需要的微信小程序后重试，或填写已有密钥。')
      if (completedProgress?.stage === 'cancelled') throw new Error('已取消获取密钥')
      return keys
    } catch (error) {
      signal?.throwIfAborted()
      if (phaseError) throw phaseError
      throw error
    } finally {
      if (progressTimer !== undefined) clearInterval(progressTimer)
      signal?.removeEventListener('abort', cancel)
      // A late authorization cannot start a new scan after this request ends.
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }

  async waitForWeChatStable(options: { minUptimeSeconds?: number; maxWaitSeconds?: number; signal?: AbortSignal } = {}): Promise<boolean> {
    const minUptimeSeconds = Math.max(1, options.minUptimeSeconds ?? MIN_ATTACH_UPTIME_SECONDS)
    const maxWaitSeconds = Math.max(minUptimeSeconds + 2, options.maxWaitSeconds ?? 30)
    const deadline = Date.now() + maxWaitSeconds * 1000
    let lastPid: number | null = null
    let seenSince = 0

    while (Date.now() < deadline) {
      options.signal?.throwIfAborted()
      const pid = this.getWeChatPid()
      if (pid) {
        if (lastPid !== pid) {
          lastPid = pid
          seenSince = Date.now()
        } else {
          const uptime = this.getWeChatUptimeSeconds(pid)
          const observedSeconds = (Date.now() - seenSince) / 1000
          const oldEnough = (uptime !== null && uptime >= minUptimeSeconds) ||
            (uptime === null && observedSeconds >= minUptimeSeconds)
          if (oldEnough) {
            await wait(800, undefined, { signal: options.signal })
            return this.getWeChatPid() === pid
          }
        }
      } else {
        lastPid = null
        seenSince = 0
      }
      await wait(400, undefined, { signal: options.signal })
    }

    return false
  }

  async autoGetDbKey(
    timeoutMs = 60_000,
    onStatus?: (message: string, level: number) => void,
    signal?: AbortSignal
  ): Promise<DbKeyResult> {
    if (this.dbKeyAbort) return { success: false, error: '已有密钥获取任务正在运行' }
    const operation = new AbortController()
    this.dbKeyAbort = operation
    this.helperAbort = false
    const cancel = () => operation.abort(signal?.reason)
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    // Independent authorization and scan deadlines are enforced in each stage.
    // This final guard only covers an unexpectedly stuck native/IPC operation.
    const deadline = setTimeout(() => operation.abort(new Error('密钥读取流程超时。请根据最后显示的授权或扫描阶段重试。')), Math.min(timeoutMs, 30_000) + WECHAT_AUTHORIZATION_TIMEOUT_MS + timeoutMs + 15_000)
    try {
      operation.signal.throwIfAborted()
      const preflight = await this.checkDbKeyPreconditions()
      if (!preflight.success) return preflight

      onStatus?.('正在读取微信内存中的数据库密钥（不下断点）...', 0)
      const candidates = await this.scanHexDbKeyCandidates(onStatus, operation.signal, timeoutMs)
      operation.signal.throwIfAborted()
      if (candidates.length > 0) {
        onStatus?.(`已从内存读到 ${candidates.length} 个候选密钥，准备验证`, 1)
        return { success: true, key: candidates[0], candidates }
      }

      if (!ALLOW_BREAKPOINT_HELPER) {
        return {
          success: false,
          error: '只读扫描已完成，但没有找到可验证的候选密钥。请确认微信已登录并打开聊天后重试，或填写已有密钥；现有连接配置会保留。',
          logs: []
        }
      }

      onStatus?.('内存扫描未命中，正在请求管理员授权并执行 helper...', 0)
      let parsed: { success: boolean; key?: string; code?: string; detail?: string; raw: string }

      try {
        const helperResult = await this.getDbKeyByHelperElevated(timeoutMs, onStatus, operation.signal)
        parsed = this.parseDbKeyResult(helperResult)
        logMacKey('log', '[WxKeyServiceMac] helper completed:', parsed.success)
      } catch (e: any) {
        const msg = `${e?.message || e}`
        if (isWechatAuthorizationCancelled(msg)) {
          return { success: false, error: '已取消管理员授权' }
        }
        throw e
      }

      if (!parsed.success) {
        const errorMsg = redactWechatKey(this.mapDbKeyErrorMessage(parsed.code, parsed.detail))
        onStatus?.(errorMsg, 2)
        return {
          success: false,
          error: errorMsg
        }
      }

      onStatus?.('密钥获取成功', 1)
      return { success: true, key: parsed.key }
    } catch (e: any) {
      if (operation.signal.aborted) {
        return { success: false, error: signal?.aborted || this.helperAbort ? '已取消获取密钥' : redactWechatKey(operation.signal.reason) }
      }
      logMacKey('error', '[WxKeyServiceMac] 获取密钥失败:', e)
      logMacKey('error', '[WxKeyServiceMac] Stack:', e.stack)
      const message = redactWechatKey(e)
      const error = message.startsWith('WECHAT_CRASHED:') ? WECHAT_CRASH_ERROR : message
      onStatus?.(`获取失败: ${error}`, 2)
      return { success: false, error }
    } finally {
      clearTimeout(deadline)
      signal?.removeEventListener('abort', cancel)
      if (this.dbKeyAbort === operation) this.dbKeyAbort = null
    }
  }

  private killHelperProcesses(): void {
    const child = this.helperChild
    this.helperChild = null
    if (child && !child.killed) {
      try { child.kill('SIGTERM') } catch { /* ignore */ }
    }
  }

  private async getDbKeyByHelperElevated(
    timeoutMs: number,
    onStatus?: (message: string, level: number) => void,
    signal?: AbortSignal
  ): Promise<string> {
    signal?.throwIfAborted()
    const helperPath = this.getHelperPath()
    const waitMs = Math.max(timeoutMs, 30_000)
    const timeoutSec = Math.ceil(waitMs / 1000) + 30
    const pid = this.getWeChatPid()

    if (!pid) {
      throw new Error('未找到微信主进程')
    }

    const uptime = this.getWeChatUptimeSeconds(pid)
    if (uptime !== null && uptime < MIN_ATTACH_UPTIME_SECONDS) {
      const ready = await this.waitForWeChatStable({
        minUptimeSeconds: MIN_ATTACH_UPTIME_SECONDS,
        maxWaitSeconds: 20,
        signal,
      })
      if (!ready || this.getWeChatPid() !== pid) {
        throw new Error('微信尚未稳定，已停止附加调试器。请等微信完全打开并登录后再试。')
      }
    }

    const dir = mkdtempSync(join(tmpdir(), 'ct-wxhelper-'))
    const wrapperPath = join(dir, 'watch_helper.py')
    const markerPath = join(dir, 'active')
    writeFileSync(wrapperPath, HELPER_WATCHDOG_PY, 'utf8')
    writeFileSync(markerPath, '', { mode: 0o600 })
    try {
      const scriptLines = [
        `set cmd to "/usr/bin/python3 " & quoted form of ${JSON.stringify(wrapperPath)} & " " & quoted form of ${JSON.stringify(helperPath)} & " ${pid} ${waitMs} " & quoted form of ${JSON.stringify(markerPath)}`,
        `set timeoutSec to ${timeoutSec}`,
        'try',
        'with timeout of timeoutSec seconds',
        'set outText to do shell script cmd with administrator privileges',
        'end timeout',
        'return "WF_OK::" & outText',
        'on error errMsg number errNum partial result pr',
        'return "WF_ERR::" & errNum & "::" & errMsg & "::" & (pr as text)',
        'end try'
      ]

      onStatus?.('请保持微信已登录。若一直没有结果，在微信里退出登录后再登录一次，并点开任意聊天。不要强制退出微信。', 0)

      this.helperAbort = false
      this.killHelperProcesses()

      const child = spawn('/usr/bin/osascript', scriptLines.flatMap(line => ['-e', line]), {
        stdio: ['ignore', 'pipe', 'pipe']
      })
      this.helperChild = child

      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

      const finished = new Promise<{ code: number | null }>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code) => resolve({ code }))
      })

      const deadline = Date.now() + waitMs + 20_000
      while (this.helperChild === child) {
        if (this.helperAbort || signal?.aborted) {
          this.killHelperProcesses()
          throw new Error('已取消管理员授权')
        }
        if (Date.now() > deadline) {
          this.killHelperProcesses()
          throw new Error('获取密钥超时')
        }
        const currentPid = this.getWeChatPid()
        if (!currentPid || currentPid !== pid) {
          this.killHelperProcesses()
          throw new Error(`WECHAT_CRASHED:${WECHAT_CRASH_ERROR}`)
        }
        const raced = await Promise.race([
          finished.then((result) => ({ done: true as const, result })),
          new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), 400)),
        ])
        if (raced.done) {
          this.helperChild = this.helperChild === child ? null : this.helperChild
          if (raced.result.code && raced.result.code !== 0 && !stdout.trim()) {
            throw new Error((stderr || stdout || 'elevated helper execution failed').trim())
          }
          break
        }
      }

      signal?.throwIfAborted()
      const lines = String(stdout).split(/\r?\n/).map(x => x.trim()).filter(Boolean)
      if (!lines.length) throw new Error('elevated helper returned empty output')

      const joined = lines.join('\n')
      if (joined.startsWith('WF_ERR::')) {
        const parts = joined.split('::')
        const errNum = parts[1] || 'unknown'
        const errMsg = parts[2] || 'unknown'
        const partial = parts.slice(3).join('::')
        throw new Error(`elevated helper failed: errNum=${errNum}, errMsg=${errMsg}, partial=${partial || '(empty)'}`)
      }

      const normalizedOutput = joined.startsWith('WF_OK::') ? joined.slice('WF_OK::'.length) : joined
      const extractJsonObjects = (s: string): any[] => {
        const results: any[] = []
        const re = /\{[^{}]*\}/g
        let m: RegExpExecArray | null
        while ((m = re.exec(s)) !== null) {
          try { results.push(JSON.parse(m[0])) } catch { }
        }
        return results
      }
      const allJson = extractJsonObjects(normalizedOutput)
      const successPayload = allJson.find(p => p?.success === true && typeof p?.key === 'string')
      if (successPayload) return successPayload.key
      const resultPayload = allJson.find(p => typeof p?.result === 'string')
      if (resultPayload) return resultPayload.result
      throw new Error('elevated helper returned invalid json: ' + redactWechatKey(lines[lines.length - 1]))
    } finally {
      // The elevated watchdog sees the missing marker and terminates its child.
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
      this.killHelperProcesses()
    }
  }

  private parseDbKeyResult(raw: any): { success: boolean; key?: string; code?: string; detail?: string; raw: string } {
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (!text) return { success: false, code: 'UNKNOWN', raw: text }
    if (/^[0-9a-f]{64}$/i.test(text)) return { success: true, key: text, raw: text }
    if (!text.startsWith('ERROR:')) return { success: false, code: 'INVALID_KEY', raw: '' }

    const parts = text.split(':')
    return {
      success: false,
      code: parts[1] || 'UNKNOWN',
      detail: parts.slice(2).join(':') || undefined,
      raw: text
    }
  }

  private mapDbKeyErrorMessage(code?: string, detail?: string): string {
    if (code === 'INVALID_KEY') return '读取组件返回了无效密钥，请更新组件或手动填写已有密钥。'
    if (code === 'PROCESS_NOT_FOUND') return '微信主进程未运行'
    if (code === 'ATTACH_FAILED') return `无法附加微信进程 (${detail || 'operation not permitted'})`
    if (code === 'SCAN_FAILED') return `未定位到目标函数 (${detail || 'sink pattern not found'})`
    if (code === 'HOOK_FAILED') return `已定位目标，但断点等待超时 (${detail || 'hook timeout'})。请在微信里退出登录后再登录，并点开任意聊天。`
    if (code === 'HOOK_TARGET_ONLY') return `仅定位到目标地址，尚未捕获到最终 DbKey (${detail || ''})。请在微信里退出登录后再登录。`
    if (code === 'WECHAT_CRASHED') return WECHAT_CRASH_ERROR
    return detail ? `${code || 'UNKNOWN'}: ${detail}` : '未知错误'
  }

  async autoGetImageKey(
    accountPath?: string,
    onStatus?: (message: string) => void,
    wxid?: string
  ): Promise<ImageKeyResult> {
    try {
      onStatus?.('正在从 kvcomm 缓存收集密钥码...')
      const codes = this.collectKvcommCodes(accountPath)
      if (codes.length === 0) {
        return { success: false, error: '未找到有效的 kvcomm 密钥码' }
      }

      const wxidCandidates = this.collectWxidCandidates(accountPath, wxid)
      const accountPathCandidates = this.collectAccountPathCandidates(accountPath)

      if (accountPathCandidates.length > 0) {
        onStatus?.(`正在校验候选账号（${wxidCandidates.length} 个）...`)
        for (const candidateAccountPath of accountPathCandidates) {
          if (!existsSync(candidateAccountPath)) continue
          const template = await this.findTemplateData(candidateAccountPath, 32)
          if (!template.ciphertext) continue

          const orderedWxids: string[] = []
          this.pushAccountIdCandidates(orderedWxids, basename(candidateAccountPath))
          for (const candidate of wxidCandidates) {
            this.pushAccountIdCandidates(orderedWxids, candidate)
          }

          for (const candidateWxid of orderedWxids) {
            for (const code of codes) {
              const { xorKey, aesKey } = this.deriveImageKeys(code, candidateWxid)
              if (!this.verifyDerivedAesKey(aesKey, template.ciphertext)) continue
              onStatus?.(`图片密钥获取成功 (wxid: ${candidateWxid}, code: ${code})`)
              return { success: true, xorKey, aesKey }
            }
          }
        }

        return {
          success: false,
          error: 'kvcomm 密钥码与当前账号目录未匹配，请确认账号目录后重试。'
        }
      }

      const fallbackWxid = wxidCandidates[0]
      const fallbackCode = codes[0]
      const { xorKey, aesKey } = this.deriveImageKeys(fallbackCode, fallbackWxid)
      onStatus?.(`图片密钥获取成功 (wxid: ${fallbackWxid}, code: ${fallbackCode})`)
      return { success: true, xorKey, aesKey }
    } catch (e: any) {
      return { success: false, error: `自动获取图片密钥失败: ${e.message}` }
    }
  }

  async autoGetImageKeyByMemoryScan(
    userDir: string,
    onProgress?: (message: string) => void
  ): Promise<ImageKeyResult> {
    try {
      const sipStatus = await this.checkSipStatus()
      if (sipStatus.enabled) {
        return {
          success: false,
          error: 'SIP (系统完整性保护) 已开启，内存扫描需要关闭 SIP 后重试'
        }
      }

      onProgress?.('正在查找图片模板文件...')
      let result = await this.findTemplateData(userDir, 32)
      let { ciphertext, xorKey } = result

      if (ciphertext && xorKey === null) {
        onProgress?.('模板尾部校验未命中，扩大扫描范围重试...')
        result = await this.findTemplateData(userDir, 100)
        xorKey = result.xorKey
      }

      if (!ciphertext) {
        return { success: false, error: '未找到 V2 模板文件，请先在微信中打开几张图片后重试。' }
      }
      if (xorKey === null) {
        return { success: false, error: '未能从模板文件中计算出有效 XOR 密钥。' }
      }

      onProgress?.(`XOR 密钥: 0x${xorKey.toString(16).padStart(2, '0')}，正在查找微信进程...`)

      const deadline = Date.now() + 60_000
      let scanCount = 0
      let lastPid: number | null = null

      while (Date.now() < deadline) {
        const pid = this.getWeChatPid()
        if (!pid) {
          onProgress?.('暂未检测到微信主进程，请先启动微信...')
          await new Promise(resolve => setTimeout(resolve, 2000))
          continue
        }

        if (lastPid !== pid) {
          lastPid = pid
          onProgress?.(`已找到微信进程 PID=${pid}，开始扫描内存...`)
        }

        scanCount += 1
        onProgress?.(`第 ${scanCount} 次扫描内存，请保持图片已在微信中打开...`)
        const aesKey = await this.scanMemoryForAesKey(pid, ciphertext, onProgress)
        if (aesKey) {
          onProgress?.('图片密钥获取成功')
          return { success: true, xorKey, aesKey }
        }

        await new Promise(resolve => setTimeout(resolve, 5000))
      }

      return { success: false, error: '60 秒内未找到 AES 密钥。' }
    } catch (e: any) {
      return { success: false, error: `内存扫描失败: ${e.message}` }
    }
  }

  detectCurrentAccount(dbPath?: string, maxTimeDiffMinutes: number = 5): { wxid: string; dbPath: string } | null {
    if (!dbPath || !existsSync(dbPath)) {
      return null
    }

    const accountDirs = this.findAccountDirectories(dbPath)
    if (accountDirs.length === 0) {
      return null
    }

    const now = Date.now()
    const maxDiffMs = maxTimeDiffMinutes * 60 * 1000
    let bestMatch: { wxid: string; dbPath: string; diff: number } | null = null
    let fallback: { wxid: string; dbPath: string; diff: number } | null = null

    for (const accountDir of accountDirs) {
      const modifiedTime = this.getAccountModifiedTime(accountDir)
      const diff = Math.abs(now - modifiedTime)
      const wxid = basename(accountDir)

      if (diff <= maxDiffMs && (!bestMatch || diff < bestMatch.diff)) {
        bestMatch = { wxid, dbPath: accountDir, diff }
      }
      if (!fallback || diff < fallback.diff) {
        fallback = { wxid, dbPath: accountDir, diff }
      }
    }

    if (bestMatch) {
      return { wxid: bestMatch.wxid, dbPath: bestMatch.dbPath }
    }

    if (fallback && (accountDirs.length === 1 || fallback.diff <= 24 * 60 * 60 * 1000)) {
      return { wxid: fallback.wxid, dbPath: fallback.dbPath }
    }

    return null
  }

  private findAccountDirectories(rootOrAccountPath: string): string[] {
    if (!existsSync(rootOrAccountPath)) return []
    if (this.isAccountDirPath(rootOrAccountPath)) return [rootOrAccountPath]

    const result: string[] = []
    try {
      for (const entry of readdirSync(rootOrAccountPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const entryPath = join(rootOrAccountPath, entry.name)
        if (!this.isReasonableAccountId(entry.name)) continue
        if (this.isAccountDirPath(entryPath)) {
          result.push(entryPath)
        }
      }
    } catch {
      // ignore
    }
    return result
  }

  private getAccountModifiedTime(accountDir: string): number {
    try {
      const accountStat = statSync(accountDir)
      let latest = accountStat.mtimeMs
      const candidates = [
        join(accountDir, 'db_storage'),
        join(accountDir, 'FileStorage', 'Image'),
        join(accountDir, 'FileStorage', 'Image2'),
        join(accountDir, 'msg', 'attach')
      ]
      for (const candidate of candidates) {
        if (existsSync(candidate)) {
          latest = Math.max(latest, statSync(candidate).mtimeMs)
        }
      }
      return latest
    } catch {
      return 0
    }
  }

  private normalizeAccountId(value: string): string {
    const trimmed = String(value || '').trim()
    if (!trimmed) return ''

    if (trimmed.toLowerCase().startsWith('wxid_')) {
      const match = trimmed.match(/^(wxid_[^_]+)/i)
      return match?.[1] || trimmed
    }

    const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
    return suffixMatch ? suffixMatch[1] : trimmed
  }

  private isIgnoredAccountName(value: string): boolean {
    const lowered = String(value || '').trim().toLowerCase()
    if (!lowered) return true
    return lowered === 'xwechat_files' ||
      lowered === 'all_users' ||
      lowered === 'backup' ||
      lowered === 'wmpf' ||
      lowered === 'app_data'
  }

  private isReasonableAccountId(value: string): boolean {
    const trimmed = String(value || '').trim()
    if (!trimmed) return false
    if (trimmed.includes('/') || trimmed.includes('\\')) return false
    return !this.isIgnoredAccountName(trimmed)
  }

  private isAccountDirPath(entryPath: string): boolean {
    return existsSync(join(entryPath, 'db_storage')) ||
      existsSync(join(entryPath, 'msg')) ||
      existsSync(join(entryPath, 'FileStorage', 'Image')) ||
      existsSync(join(entryPath, 'FileStorage', 'Image2'))
  }

  private resolveXwechatRootFromPath(accountPath?: string): string | null {
    const normalized = String(accountPath || '').replace(/\\/g, '/').replace(/\/+$/, '')
    if (!normalized) return null

    const oldMarker = '/xwechat_files'
    const oldIndex = normalized.indexOf(oldMarker)
    if (oldIndex >= 0) {
      return normalized.slice(0, oldIndex + oldMarker.length)
    }

    const newMarkerMatch = normalized.match(/^(.*\/com\.tencent\.xinWeChat\/(?:\d+\.\d+b\d+\.\d+|\d+\.\d+\.\d+))(\/|$)/)
    if (newMarkerMatch) {
      return newMarkerMatch[1]
    }

    return null
  }

  private pushAccountIdCandidates(candidates: string[], value?: string): void {
    const raw = String(value || '').trim()
    if (!this.isReasonableAccountId(raw)) return

    const pushUnique = (item: string) => {
      const trimmed = String(item || '').trim()
      if (!trimmed || candidates.includes(trimmed)) return
      candidates.push(trimmed)
    }

    pushUnique(raw)
    const normalized = this.normalizeAccountId(raw)
    if (normalized && normalized !== raw && this.isReasonableAccountId(normalized)) {
      pushUnique(normalized)
    }
  }

  private cleanWxid(wxid: string): string {
    return this.normalizeAccountId(wxid)
  }

  private deriveImageKeys(code: number, wxid: string): { xorKey: number; aesKey: string } {
    const cleanedWxid = this.cleanWxid(wxid)
    const xorKey = code & 0xFF
    const dataToHash = code.toString() + cleanedWxid
    const aesKey = crypto.createHash('md5').update(dataToHash).digest('hex').substring(0, 16)
    return { xorKey, aesKey }
  }

  private collectWxidCandidates(accountPath?: string, wxidParam?: string): string[] {
    const candidates: string[] = []
    this.pushAccountIdCandidates(candidates, wxidParam)

    if (accountPath) {
      const normalized = accountPath.replace(/\\/g, '/').replace(/\/+$/, '')
      this.pushAccountIdCandidates(candidates, basename(normalized))

      const root = this.resolveXwechatRootFromPath(accountPath)
      if (root && existsSync(root)) {
        try {
          for (const entry of readdirSync(root, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue
            const entryPath = join(root, entry.name)
            if (this.isAccountDirPath(entryPath)) {
              this.pushAccountIdCandidates(candidates, entry.name)
            }
          }
        } catch {
          // ignore
        }
      }
    }

    return candidates.length > 0 ? candidates : ['unknown']
  }

  private collectAccountPathCandidates(accountPath?: string): string[] {
    const candidates: string[] = []
    const pushUnique = (value?: string) => {
      const item = String(value || '').trim()
      if (!item || candidates.includes(item)) return
      candidates.push(item)
    }

    if (accountPath) pushUnique(accountPath)

    if (accountPath) {
      const root = this.resolveXwechatRootFromPath(accountPath)
      if (root && existsSync(root)) {
        try {
          for (const entry of readdirSync(root, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue
            const entryPath = join(root, entry.name)
            if (!this.isReasonableAccountId(entry.name)) continue
            if (this.isAccountDirPath(entryPath)) {
              pushUnique(entryPath)
            }
          }
        } catch {
          // ignore
        }
      }
    }

    return candidates
  }

  private verifyDerivedAesKey(aesKey: string, ciphertext: Buffer): boolean {
    try {
      const keyBytes = Buffer.from(aesKey, 'ascii').subarray(0, 16)
      const decipher = crypto.createDecipheriv('aes-128-ecb', keyBytes, null)
      decipher.setAutoPadding(false)
      const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      return (
        (dec[0] === 0xFF && dec[1] === 0xD8 && dec[2] === 0xFF) ||
        (dec[0] === 0x89 && dec[1] === 0x50 && dec[2] === 0x4E && dec[3] === 0x47) ||
        (dec[0] === 0x52 && dec[1] === 0x49 && dec[2] === 0x46 && dec[3] === 0x46) ||
        (dec[0] === 0x77 && dec[1] === 0x78 && dec[2] === 0x67 && dec[3] === 0x66) ||
        (dec[0] === 0x47 && dec[1] === 0x49 && dec[2] === 0x46)
      )
    } catch {
      return false
    }
  }

  private collectKvcommCodes(accountPath?: string): number[] {
    const codeSet = new Set<number>()
    const pattern = /^key_(\d+)_.+\.statistic$/i

    for (const kvcommDir of this.getKvcommCandidates(accountPath)) {
      if (!existsSync(kvcommDir)) continue
      try {
        for (const file of readdirSync(kvcommDir)) {
          const match = file.match(pattern)
          if (!match) continue
          const code = Number(match[1])
          if (Number.isFinite(code) && code > 0 && code <= 0xFFFFFFFF) {
            codeSet.add(code)
          }
        }
      } catch {
        // ignore
      }
    }

    return Array.from(codeSet)
  }

  private getKvcommCandidates(accountPath?: string): string[] {
    const home = homedir()
    const candidates = new Set<string>([
      join(home, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Documents', 'app_data', 'net', 'kvcomm'),
      join(home, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Library', 'Application Support', 'com.tencent.xinWeChat', 'xwechat', 'net', 'kvcomm'),
      join(home, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Library', 'Application Support', 'com.tencent.xinWeChat', 'net', 'kvcomm'),
      join(home, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Documents', 'xwechat', 'net', 'kvcomm')
    ])

    if (accountPath) {
      const normalized = accountPath.replace(/\\/g, '/').replace(/\/+$/, '')
      const oldMarker = '/xwechat_files'
      const oldIndex = normalized.indexOf(oldMarker)
      if (oldIndex >= 0) {
        candidates.add(`${normalized.slice(0, oldIndex)}/app_data/net/kvcomm`)
      }

      const newMarkerMatch = normalized.match(/^(.*\/com\.tencent\.xinWeChat\/(?:\d+\.\d+b\d+\.\d+|\d+\.\d+\.\d+))/)
      if (newMarkerMatch) {
        const versionBase = newMarkerMatch[1]
        candidates.add(`${versionBase}/net/kvcomm`)
        candidates.add(`${versionBase.replace(/\/[^\/]+$/, '')}/net/kvcomm`)
      }

      let cursor = accountPath
      for (let i = 0; i < 6; i++) {
        candidates.add(join(cursor, 'net', 'kvcomm'))
        const next = dirname(cursor)
        if (next === cursor) break
        cursor = next
      }
    }

    return Array.from(candidates)
  }

  private async findTemplateData(userDir: string, limit = 32): Promise<{ ciphertext: Buffer | null; xorKey: number | null }> {
    const magic = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07])
    const files: string[] = []

    const collect = (dir: string) => {
      if (files.length >= limit) return
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (files.length >= limit) break
          const fullPath = join(dir, entry.name)
          if (entry.isDirectory()) {
            collect(fullPath)
          } else if (entry.isFile() && entry.name.endsWith('_t.dat')) {
            files.push(fullPath)
          }
        }
      } catch {
        // ignore
      }
    }

    collect(userDir)
    files.sort((a, b) => {
      try {
        return statSync(b).mtimeMs - statSync(a).mtimeMs
      } catch {
        return 0
      }
    })

    let ciphertext: Buffer | null = null
    const tailCounts = new Map<string, number>()

    for (const file of files.slice(0, 32)) {
      try {
        const data = readFileSync(file)
        if (data.length < 8 || !data.subarray(0, 6).equals(magic)) continue

        if (data.length >= 0x1F && !ciphertext) {
          ciphertext = data.subarray(0x0F, 0x1F)
        }

        const key = `${data[data.length - 2]}_${data[data.length - 1]}`
        tailCounts.set(key, (tailCounts.get(key) || 0) + 1)
      } catch {
        // ignore
      }
    }

    let xorKey: number | null = null
    let maxCount = 0

    for (const [key, count] of tailCounts.entries()) {
      if (count <= maxCount) continue
      const [x, y] = key.split('_').map(Number)
      const candidate = x ^ 0xFF
      if (candidate === (y ^ 0xD9)) {
        maxCount = count
        xorKey = candidate
      }
    }

    return { ciphertext, xorKey }
  }

  private ensureMachApis(): boolean {
    if (this.machTaskSelf && this.taskForPid && this.machVmRegion && this.machVmReadOverwrite) {
      return true
    }

    try {
      if (!this.koffi) {
        this.koffi = require('koffi')
      }

      logMacKey('log', '[WxKeyServiceMac] 加载 Mach API: /usr/lib/libSystem.B.dylib')
      this.libSystem = this.koffi.load('/usr/lib/libSystem.B.dylib')
      this.machTaskSelf = this.libSystem.func('mach_task_self', 'uint32', [])
      this.taskForPid = this.libSystem.func('task_for_pid', 'int', ['uint32', 'int', this.koffi.out('uint32*')])
      this.machVmRegion = this.libSystem.func('mach_vm_region', 'int', [
        'uint32',
        this.koffi.out('uint64*'),
        this.koffi.out('uint64*'),
        'int',
        'void*',
        this.koffi.out('uint32*'),
        this.koffi.out('uint32*')
      ])
      this.machVmReadOverwrite = this.libSystem.func('mach_vm_read_overwrite', 'int', [
        'uint32',
        'uint64',
        'uint64',
        'void*',
        this.koffi.out('uint64*')
      ])
      this.machPortDeallocate = this.libSystem.func('mach_port_deallocate', 'int', ['uint32', 'uint32'])
      return true
    } catch (e: any) {
      logMacKey('error', '[WxKeyServiceMac] 初始化 Mach API 失败:', e?.message || e)
      return false
    }
  }

  private async scanMemoryForAesKey(
    pid: number,
    ciphertext: Buffer,
    onProgress?: (message: string) => void
  ): Promise<string | null> {
    try {
      const helperPath = this.getImageScanHelperPath()
      const ciphertextHex = ciphertext.toString('hex')

      if (!this.needsElevation) {
        const direct = await this.spawnScanHelper(helperPath, pid, ciphertextHex, false)
        if (direct.key) return direct.key
        if (direct.permissionError) {
          this.needsElevation = true
          onProgress?.('需要管理员权限，正在切换提权扫描...')
        }
      }

      if (this.needsElevation) {
        const elevated = await this.spawnScanHelper(helperPath, pid, ciphertextHex, true)
        if (elevated.key) return elevated.key
      }
    } catch (e: any) {
      logMacKey('warn', '[WxKeyServiceMac] image_scan_helper 不可用，回退 Mach API:', e.message)
    }

    if (!this.ensureMachApis()) {
      return null
    }

    const VM_PROT_READ = 0x1
    const VM_PROT_WRITE = 0x2
    const VM_REGION_BASIC_INFO_64 = 9
    const VM_REGION_BASIC_INFO_COUNT_64 = 9
    const KERN_SUCCESS = 0
    const MAX_REGION_SIZE = 50 * 1024 * 1024
    const CHUNK = 4 * 1024 * 1024
    const OVERLAP = 65

    const selfTask = this.machTaskSelf()
    const taskBuf = Buffer.alloc(4)
    const attachKr = this.taskForPid(selfTask, pid, taskBuf)
    const task = taskBuf.readUInt32LE(0)
    if (attachKr !== KERN_SUCCESS || !task) {
      logMacKey('error', `[WxKeyServiceMac] task_for_pid 失败: kr=${attachKr}, task=${task}, pid=${pid}（可能需要关闭 SIP 或授予调试权限）`)
      return null
    }

    try {
      const regions: Array<[number, number]> = []
      let address = 0

      while (address < 0x7FFFFFFFFFFF) {
        const addrBuf = Buffer.alloc(8)
        addrBuf.writeBigUInt64LE(BigInt(address), 0)
        const sizeBuf = Buffer.alloc(8)
        const infoBuf = Buffer.alloc(64)
        const countBuf = Buffer.alloc(4)
        countBuf.writeUInt32LE(VM_REGION_BASIC_INFO_COUNT_64, 0)
        const objectBuf = Buffer.alloc(4)

        const kr = this.machVmRegion(task, addrBuf, sizeBuf, VM_REGION_BASIC_INFO_64, infoBuf, countBuf, objectBuf)
        if (kr !== KERN_SUCCESS) break

        const base = Number(addrBuf.readBigUInt64LE(0))
        const size = Number(sizeBuf.readBigUInt64LE(0))
        const protection = infoBuf.readInt32LE(0)
        const objectName = objectBuf.readUInt32LE(0)
        if (objectName) {
          try { this.machPortDeallocate(selfTask, objectName) } catch { }
        }

        if ((protection & VM_PROT_READ) !== 0 && (protection & VM_PROT_WRITE) !== 0 && size > 0 && size <= MAX_REGION_SIZE) {
          regions.push([base, size])
        }

        const next = base + size
        if (next <= address) break
        address = next
      }

      const totalMB = regions.reduce((sum, [, size]) => sum + size, 0) / 1024 / 1024
      onProgress?.(`扫描 ${regions.length} 个内存区域 (${totalMB.toFixed(0)} MB)...`)

      for (let regionIndex = 0; regionIndex < regions.length; regionIndex++) {
        const [base, size] = regions[regionIndex]
        if (regionIndex % 20 === 0) {
          onProgress?.(`扫描进度 ${regionIndex}/${regions.length}...`)
          await new Promise(resolve => setTimeout(resolve, 1))
        }

        let offset = 0
        let trailing: Buffer | null = null

        while (offset < size) {
          const chunkSize = Math.min(CHUNK, size - offset)
          const chunk = Buffer.alloc(chunkSize)
          const outSizeBuf = Buffer.alloc(8)
          const kr = this.machVmReadOverwrite(task, base + offset, chunkSize, chunk, outSizeBuf)
          const bytesRead = Number(outSizeBuf.readBigUInt64LE(0))
          offset += chunkSize

          if (kr !== KERN_SUCCESS || bytesRead <= 0) {
            trailing = null
            continue
          }

          const current = chunk.subarray(0, bytesRead)
          const data: Buffer = trailing ? Buffer.concat([trailing, current]) : current
          const key = this.searchAsciiKey(data, ciphertext) || this.searchUtf16Key(data, ciphertext) || this.searchAny16Key(data, ciphertext)
          if (key) return key
          trailing = data.subarray(Math.max(0, data.length - OVERLAP))
        }
      }
    } finally {
      try { this.machPortDeallocate(selfTask, task) } catch { }
    }

    return null
  }

  private spawnScanHelper(
    helperPath: string,
    pid: number,
    ciphertextHex: string,
    elevated: boolean
  ): Promise<{ key: string | null; permissionError: boolean }> {
    return new Promise((resolve, reject) => {
      let child: any

      if (elevated) {
        const shellCmd = `'${helperPath}' ${pid} ${ciphertextHex}`
        child = spawn('/usr/bin/osascript', ['-e', `do shell script ${JSON.stringify(shellCmd)} with administrator privileges`], {
          stdio: ['ignore', 'pipe', 'pipe']
        })
      } else {
        child = spawn(helperPath, [String(pid), ciphertextHex], { stdio: ['ignore', 'pipe', 'pipe'] })
      }

      let stdout = ''
      let stderr = ''

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('error', reject)
      child.on('close', () => {
        const permissionError = !elevated && stderr.includes('task_for_pid failed')
        try {
          const lines = stdout.split(/\r?\n/).map(x => x.trim()).filter(Boolean)
          const last = lines[lines.length - 1]
          if (!last) {
            resolve({ key: null, permissionError })
            return
          }
          const payload = JSON.parse(last)
          resolve({
            key: payload?.success && payload?.aesKey ? payload.aesKey : null,
            permissionError
          })
        } catch {
          resolve({ key: null, permissionError })
        }
      })

      setTimeout(() => {
        try { child.kill('SIGTERM') } catch { }
      }, elevated ? 60_000 : 30_000)
    })
  }

  private searchAsciiKey(data: Buffer, ciphertext: Buffer): string | null {
    for (let i = 0; i < data.length - 34; i++) {
      if (this.isAlphaNum(data[i])) continue
      let valid = true
      for (let j = 1; j <= 32; j++) {
        if (!this.isAlphaNum(data[i + j])) {
          valid = false
          break
        }
      }
      if (!valid) continue
      if (i + 33 < data.length && this.isAlphaNum(data[i + 33])) continue
      const keyBytes = data.subarray(i + 1, i + 33)
      if (this.verifyAesKey(keyBytes, ciphertext)) {
        return keyBytes.toString('ascii').substring(0, 16)
      }
    }
    return null
  }

  private searchUtf16Key(data: Buffer, ciphertext: Buffer): string | null {
    for (let i = 0; i < data.length - 65; i++) {
      let valid = true
      for (let j = 0; j < 32; j++) {
        if (data[i + j * 2 + 1] !== 0x00 || !this.isAlphaNum(data[i + j * 2])) {
          valid = false
          break
        }
      }
      if (!valid) continue

      const keyBytes = Buffer.alloc(32)
      for (let j = 0; j < 32; j++) {
        keyBytes[j] = data[i + j * 2]
      }
      if (this.verifyAesKey(keyBytes, ciphertext)) {
        return keyBytes.toString('ascii').substring(0, 16)
      }
    }
    return null
  }

  private searchAny16Key(data: Buffer, ciphertext: Buffer): string | null {
    for (let i = 0; i + 16 <= data.length; i++) {
      const keyBytes = data.subarray(i, i + 16)
      if (!this.verifyAesKey16Raw(keyBytes, ciphertext)) continue
      if (!this.isMostlyPrintableAscii(keyBytes)) continue
      return keyBytes.toString('ascii')
    }
    return null
  }

  private isAlphaNum(byte: number): boolean {
    return (byte >= 0x61 && byte <= 0x7A) || (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x30 && byte <= 0x39)
  }

  private verifyAesKey(keyBytes: Buffer, ciphertext: Buffer): boolean {
    try {
      const decipher = crypto.createDecipheriv('aes-128-ecb', keyBytes.subarray(0, 16), null)
      decipher.setAutoPadding(false)
      const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      return (
        (dec[0] === 0xFF && dec[1] === 0xD8 && dec[2] === 0xFF) ||
        (dec[0] === 0x89 && dec[1] === 0x50 && dec[2] === 0x4E && dec[3] === 0x47) ||
        (dec[0] === 0x52 && dec[1] === 0x49 && dec[2] === 0x46 && dec[3] === 0x46) ||
        (dec[0] === 0x77 && dec[1] === 0x78 && dec[2] === 0x67 && dec[3] === 0x66) ||
        (dec[0] === 0x47 && dec[1] === 0x49 && dec[2] === 0x46)
      )
    } catch {
      return false
    }
  }

  private verifyAesKey16Raw(keyBytes: Buffer, ciphertext: Buffer): boolean {
    try {
      const decipher = crypto.createDecipheriv('aes-128-ecb', keyBytes, null)
      decipher.setAutoPadding(false)
      const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      return (
        (dec[0] === 0xFF && dec[1] === 0xD8 && dec[2] === 0xFF) ||
        (dec[0] === 0x89 && dec[1] === 0x50 && dec[2] === 0x4E && dec[3] === 0x47) ||
        (dec[0] === 0x52 && dec[1] === 0x49 && dec[2] === 0x46 && dec[3] === 0x46) ||
        (dec[0] === 0x77 && dec[1] === 0x78 && dec[2] === 0x67 && dec[3] === 0x66) ||
        (dec[0] === 0x47 && dec[1] === 0x49 && dec[2] === 0x46)
      )
    } catch {
      return false
    }
  }

  private isMostlyPrintableAscii(keyBytes: Buffer): boolean {
    let printable = 0
    for (const byte of keyBytes) {
      if (byte >= 0x20 && byte <= 0x7E) {
        printable += 1
      }
    }
    return printable >= 14
  }

  dispose(): void {
    this.helperAbort = true
    this.dbKeyAbort?.abort()
    this.killHelperProcesses()
    this.libSystem = null
    this.machTaskSelf = null
    this.taskForPid = null
    this.machVmRegion = null
    this.machVmReadOverwrite = null
    this.machPortDeallocate = null
  }
}

export const wxKeyServiceMac = new WxKeyServiceMac()
