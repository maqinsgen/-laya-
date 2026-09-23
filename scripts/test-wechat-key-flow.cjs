const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const ts = require('typescript')

// Load only these modules with explicit dependencies. No Electron app, native
// library, process inspection or user WeChat directory is touched by this test.
function loadTs(relativePath, dependencies = {}, globals = {}) {
  const filename = path.join(__dirname, '..', relativePath)
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const module = { exports: {} }
  const mockRequire = name => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name]
    throw new Error(`Unexpected dependency: ${name}`)
  }
  mockRequire.resolve = () => 'mock-native-module'
  vm.runInNewContext(code, {
    module, exports: module.exports, require: mockRequire, AbortController, Error,
    ...globals,
  }, { filename })
  return module.exports
}

const shared = loadTs('src/shared/wechatConnection.ts')
const acquisition = loadTs('src/shared/wechatKeyAcquisition.ts')
const key = 'a1'.repeat(32)
const tick = () => new Promise(resolve => setImmediate(resolve))
const account = { dbKey: key, wxid: 'wxid_test', name: '', number: '', phone: '', seed: 0 }

function fixture(options = {}) {
  const handlers = new Map()
  const logs = []
  let scans = 0
  let validations = 0
  let prohibitedActions = 0
  const wxService = {
    getScanDllPath: () => '/mock/component.dll',
    isWeChatRunning: () => options.running !== false,
    scanAccountAsync: async signal => {
      scans++
      if (options.scan) return options.scan(signal)
      return options.noKey ? null : account
    },
    scanDbKeyDiagAsync: async () => options.diag || null,
    detectCurrentAccount: () => ({ wxid: 'wxid_test' }),
    dispose: () => {},
    killWeChat: () => { prohibitedActions++ },
    launchWeChat: () => { prohibitedActions++ },
  }
  const macService = {
    ...wxService,
    checkSipStatus: async () => ({ enabled: options.sip !== false }),
    checkDbKeyPreconditions: async () => ({ success: true }),
    waitForWeChatStable: async () => true,
    autoGetDbKey: async (_timeout, onStatus, signal) => {
      scans++
      return options.macScan ? options.macScan(signal, onStatus) : { success: true, key }
    },
  }
  const loaded = loadTs('electron/main/ipc/wxKeyHandlers.ts', {
    electron: { ipcMain: { handle: (name, handler) => handlers.set(name, handler) } },
    path,
    fs: { accessSync() {}, constants: { R_OK: 4 }, existsSync: () => true, statSync: () => ({ isDirectory: () => true }) },
    'timers/promises': { setTimeout: async (_delay, _value, { signal }) => { await tick(); signal?.throwIfAborted() } },
    '../../services/dbPathService': { dbPathService: { scanWxids: () => ['wxid_test'] } },
    '../../services/wcdbService': { wcdbService: { testConnection: async (...args) => {
      validations++
      return options.validate ? options.validate(...args) : { success: true }
    } } },
    '../../services/wxKeyService': { wxKeyService: wxService },
    '../../services/wxKeyServiceMac': { wxKeyServiceMac: macService },
    '../../services/wechatLoginCaptureService': { wechatLoginCaptureService: {
      checkRuntime: async () => ({ ready: options.runtimeReady !== false, error: options.runtimeReady === false ? 'LLDB unavailable' : undefined }),
      capture: async ({ signal, onStatus, wxid }) => {
        scans++
        if (options.macScan) return options.macScan(signal, onStatus, wxid)
        return { success: true, key, validatedWxid: 'wxid_test' }
      },
    } },
    '../../../src/shared/wechatConnection': shared,
  }, { process: { platform: options.platform || 'win32', arch: options.platform === 'darwin' ? 'arm64' : 'x64' } })
  loaded.registerWxKeyHandlers({ getLogService: () => Object.fromEntries(
    ['info', 'warn', 'error'].map(level => [level, (...args) => logs.push(args)]),
  ) })
  const sender = new EventEmitter()
  const statuses = []
  sender.isDestroyed = () => false
  sender.send = (_name, data) => statuses.push(data)
  return {
    start: (wxid) => handlers.get('wxkey:startGetKey')({ sender }, undefined, '/mock/data', wxid),
    cancel: () => handlers.get('wxkey:cancel')(),
    preflight: () => handlers.get('wxkey:preflight')({}, '/mock/data'),
    sender, statuses, logs,
    stats: () => ({ scans, validations, prohibitedActions }),
  }
}

function assertNoAcquisitionListeners(sender) {
  for (const name of ['destroyed', 'did-start-navigation', 'render-process-gone']) {
    assert.equal(sender.listenerCount(name), 0, `${name} listener must be released after the acquisition settles`)
  }
}

// Advance service deadlines without sleeping or launching a privileged process.
function fakeClock() {
  let now = 1000
  let serial = 0
  const timers = new Map()
  const schedule = (callback, delay, repeat) => {
    const id = ++serial
    timers.set(id, { callback, at: now + Math.max(1, delay), repeat })
    return id
  }
  return {
    Date: class extends Date { static now() { return now } },
    setTimeout: (callback, delay = 0) => schedule(callback, delay, 0),
    clearTimeout: id => timers.delete(id),
    setInterval: (callback, delay) => schedule(callback, delay, Math.max(1, delay)),
    clearInterval: id => timers.delete(id),
    pending: () => timers.size,
    async advance(delay) {
      const target = now + delay
      let executions = 0
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0]
        if (!next) break
        assert.ok(++executions < 10_000, 'a test must not spin indefinitely')
        const [id, timer] = next
        now = timer.at
        if (timer.repeat) timer.at += timer.repeat
        else timers.delete(id)
        timer.callback()
        await tick()
      }
      now = target
      await tick()
    },
  }
}

function trackedController() {
  const controller = new AbortController()
  const listeners = new Set()
  const add = controller.signal.addEventListener.bind(controller.signal)
  const remove = controller.signal.removeEventListener.bind(controller.signal)
  controller.signal.addEventListener = (name, listener, options) => {
    if (name === 'abort') listeners.add(listener)
    return add(name, listener, options)
  }
  controller.signal.removeEventListener = (name, listener, options) => {
    if (name === 'abort') listeners.delete(listener)
    return remove(name, listener, options)
  }
  return { controller, listenerCount: () => listeners.size }
}

function macFixture(options = {}) {
  const clock = fakeClock()
  const files = new Map()
  const directories = new Set()
  const calls = []
  const statuses = []
  let serial = 0
  const mockedFs = {
    mkdtempSync: prefix => {
      const dir = `${prefix}synthetic-${++serial}`
      directories.add(dir)
      return dir
    },
    writeFileSync: (filename, content) => files.set(filename, String(content)),
    readFileSync: filename => {
      if (!files.has(filename)) throw new Error('ENOENT: synthetic file')
      return files.get(filename)
    },
    rmSync: filename => {
      directories.delete(filename)
      for (const entry of files.keys()) if (entry === filename || entry.startsWith(`${filename}/`)) files.delete(entry)
    },
  }
  const execFile = () => { throw new Error('unpromisified process execution is prohibited in this test') }
  execFile[require('node:util').promisify.custom] = (command, args, options) => {
    assert.equal(command, '/usr/bin/osascript')
    let abort
    const promise = new Promise((resolve, reject) => {
      abort = () => reject(options.signal.reason || new Error('aborted'))
      options.signal.addEventListener('abort', abort, { once: true })
      const call = { args, options, resolve: stdout => resolve({ stdout }), reject }
      calls.push(call)
      if (options.signal.aborted) abort()
    })
    return promise.finally(() => options.signal.removeEventListener('abort', abort))
  }
  const { WxKeyServiceMac } = loadTs('electron/services/wxKeyServiceMac.ts', {
    electron: { app: {} }, path, fs: mockedFs,
    child_process: { execFile, execSync() { throw new Error('process inspection is prohibited in this test') }, spawn() { throw new Error('helper spawning is prohibited in this test') } },
    util: require('node:util'), crypto: {}, os: { tmpdir: () => '/synthetic-temp' },
    'timers/promises': { setTimeout: options.wait || (() => { throw new Error('unexpected native scan wait') }) },
    './wechatMemoryScan': options.memoryScan || { WECHAT_HEX_SCAN_PY: '# synthetic script, never executed', collectWechatHexCandidates() { throw new Error('memory reads are prohibited in this test') } },
    '../../src/shared/wechatConnection': shared,
    '../../src/shared/wechatKeyAcquisition': acquisition,
  }, { process: { env: {} }, Buffer, ...clock })
  const mac = new WxKeyServiceMac()
  mac.checkDbKeyPreconditions = async () => ({ success: true })
  mac.getWeChatPid = () => 12345
  if (!options.localMach) mac.scanHexKeysWithMach = async () => null // null means elevation is needed, not an empty successful scan.
  const onStatus = (message, level) => statuses.push({ message, level })
  return {
    mac, clock, calls, statuses, onStatus,
    elevated: signal => mac.scanHexKeysElevated(12345, signal, 1000, onStatus),
    progress: (stage, extra = {}) => {
      const dir = [...directories][0]
      assert.ok(dir, 'the isolated acquisition must own a temporary directory')
      files.set(path.join(dir, 'progress.json'), JSON.stringify({ stage, regions: 3, scannedBytes: 4 * 1_048_576, candidates: 0, elapsedMs: 500, ...extra }))
    },
    assertClean() {
      assert.equal(clock.pending(), 0, 'all progress/deadline timers must be released')
      assert.equal(files.size, 0, 'the active marker and temporary files must be removed')
      assert.equal(directories.size, 0, 'the temporary directory must be removed')
      assert.equal(mac.dbKeyAbort, null, 'the acquisition lock must be released')
      assert.equal(JSON.stringify(statuses).includes(key), false, 'progress must not contain a key')
    },
  }
}

const outcome = promise => promise.then(value => ({ value }), error => ({ error }))

async function checkLocalMachChunks() {
  const memoryScan = loadTs('electron/services/wechatMemoryScan.ts', {}, { Buffer })
  const chunkSize = 4 * 1024 * 1024
  const regionSize = 84 * 1024 * 1024
  const base = 0x1000
  const smallBase = base + regionSize
  const smallKey = 'bc'.repeat(32)
  const reads = []
  const released = []
  let waits = 0
  let regions = 0
  const app = macFixture({ localMach: true, memoryScan, wait: async (_delay, _value, { signal }) => {
    signal?.throwIfAborted()
    // Read the small region and two bounded chunks, then reach the deadline. Never allocate
    // the advertised 84 MiB region or scan irrelevant remaining memory.
    if (++waits === 4) await app.clock.advance(1000)
  } })
  const mac = app.mac
  mac.ensureMachApis = () => true
  mac.machTaskSelf = () => 11
  mac.taskForPid = (_self, pid, task) => { assert.equal(pid, 12345); task.writeUInt32LE(22); return 0 }
  mac.machPortDeallocate = (self, port) => released.push([self, port])
  mac.machVmRegion = (_task, address, size, _flavor, info, _count, object) => {
    if (++regions === 3) return 1 // End of the synthetic memory map.
    assert.ok(regions <= 2)
    address.writeBigUInt64LE(BigInt(regions === 1 ? base : smallBase))
    size.writeBigUInt64LE(BigInt(regions === 1 ? regionSize : 512))
    info.writeInt32LE(3) // Readable and writable.
    object.writeUInt32LE(regions === 1 ? 33 : 34)
    return 0
  }
  mac.machVmReadOverwrite = (task, address, requested, buffer, size) => {
    assert.equal(task, 22)
    reads.push({ address, requested })
    assert.ok(reads.length <= 3, 'only one small region and two large-region chunks are needed')
    assert.equal(buffer.length, address === smallBase ? 512 : chunkSize)
    if (address === smallBase) buffer.write(smallKey, 1, 'ascii')
    else if (address === base) buffer.write(key.slice(0, 31), chunkSize - 31, 'ascii')
    else buffer.write(key.slice(31), 0, 'ascii')
    size.writeBigUInt64LE(BigInt(requested))
    return 0
  }
  const candidates = await mac.scanHexKeysWithMach(12345, app.onStatus, undefined, 1000)
  assert.deepEqual(new Set(candidates), new Set([key, smallKey]), 'the real stream must recover both the small-region key and the key split across a 4 MiB boundary')
  assert.deepEqual(reads, [{ address: smallBase, requested: 512 }, { address: base, requested: chunkSize }, { address: base + chunkSize, requested: chunkSize }], 'small regions later in the memory map must be read before bounded chunks of a region above 80 MiB')
  assert.deepEqual(released, [[11, 33], [11, 34], [11, 22]], 'all region objects and the acquired task port must be released after timeout')
  assert.ok(app.statuses.some(entry => /扫描时间已到.*保留已发现候选/.test(entry.message)))
  app.assertClean()

  // Absence of Mach APIs and attach denial both mean elevation is required,
  // while a successful scan with no candidates would instead return [].
  mac.ensureMachApis = () => false
  assert.equal(await mac.scanHexKeysWithMach(12345), null)
  mac.ensureMachApis = () => true
  mac.taskForPid = () => 5
  assert.equal(await mac.scanHexKeysWithMach(12345), null)
  assert.equal(released.length, 3, 'no task port was acquired on permission denial')
  assert.equal(reads.length, 3, 'permission denial must never read memory')

  // Also prove the finally path on a read error without another large buffer.
  mac.taskForPid = (_self, _pid, task) => { task.writeUInt32LE(44); return 0 }
  let readErrorRegions = 0
  mac.machVmRegion = (_task, address, size, _flavor, info) => {
    if (++readErrorRegions > 1) return 1
    address.writeBigUInt64LE(BigInt(base)); size.writeBigUInt64LE(8n); info.writeInt32LE(3); return 0
  }
  mac.machVmReadOverwrite = () => { throw new Error('synthetic Mach read failure') }
  await assert.rejects(mac.scanHexKeysWithMach(12345), /synthetic Mach read failure/)
  assert.deepEqual(released.at(-1), [11, 44], 'an exception must also release the acquired task port')
  app.assertClean()
}

async function checkMacAcquisitionStages() {
  const progress = acquisition.parseWechatMemoryProgress({
    stage: 'scanning', regions: 3, scannedBytes: 4 * 1_048_576, candidates: 2, elapsedMs: 700,
    key, details: key, errorCode: key,
  })
  assert.equal(JSON.stringify(progress).includes(key), false)
  assert.equal(Object.keys(progress).length, 5, 'only fixed safe progress fields cross the helper boundary')
  assert.match(acquisition.formatWechatMemoryProgress(progress), /3 个内存区.*4 MB.*2 个候选/)
  for (const invalid of [-1, 1.2, Infinity, Number.MAX_SAFE_INTEGER + 1, '3']) {
    assert.equal(acquisition.parseWechatMemoryProgress({ ...progress, regions: invalid }), null)
  }
  assert.equal(acquisition.parseWechatMemoryProgress({ ...progress, stage: key }), null)
  assert.equal(acquisition.parseWechatMemoryProgress(null), null)
  for (const message of ['WF_ERR::-128::用户已取消。', '执行错误：用户取消了操作。(-128)', 'User canceled', 'User cancelled']) {
    assert.equal(acquisition.isWechatAuthorizationCancelled(message), true)
  }
  assert.equal(acquisition.isWechatAuthorizationCancelled('WF_ERR::-1280::其他错误'), false)

  // A final guard is deliberately longer than a scan. It must not count the
  // user's authorization time as a 10ms scan timeout or leave real timers alive.
  const stalled = macFixture()
  stalled.mac.scanHexDbKeyCandidates = async (_status, signal) => new Promise((_resolve, reject) => {
    signal.throwIfAborted()
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  let guardSettled = false
  const guard = stalled.mac.autoGetDbKey(10).then(result => { guardSettled = true; return result })
  await tick()
  await stalled.clock.advance(10)
  assert.equal(guardSettled, false, 'authorization has its own budget beyond the scan budget')
  await stalled.clock.advance(acquisition.WECHAT_AUTHORIZATION_TIMEOUT_MS + 30_000)
  assert.match((await guard).error, /流程超时/)
  stalled.assertClean()

  const authorization = macFixture()
  const authorizationResult = outcome(authorization.elevated())
  authorization.progress('scanning', { regions: -1, key }) // Malformed progress cannot claim authorization succeeded.
  assert.ok(authorization.calls[0].options.timeout > acquisition.WECHAT_AUTHORIZATION_TIMEOUT_MS + 1000)
  await authorization.clock.advance(acquisition.WECHAT_AUTHORIZATION_TIMEOUT_MS - 1)
  assert.equal(authorization.calls[0].options.signal.aborted, false)
  await authorization.clock.advance(1)
  assert.match((await authorizationResult).error.message, /管理员授权超时，尚未开始内存扫描/)
  assert.equal(authorization.statuses.length, 0)
  authorization.assertClean()

  const scan = macFixture()
  const scanResult = outcome(scan.elevated())
  await scan.clock.advance(2000)
  assert.equal(scan.calls[0].options.signal.aborted, false, 'waiting for authorization must not consume the short scan budget')
  scan.progress('authorized', { key })
  await scan.clock.advance(250)
  scan.progress('scanning', { candidates: 1, key })
  await scan.clock.advance(5999)
  assert.equal(scan.calls[0].options.signal.aborted, false)
  await scan.clock.advance(1)
  assert.match((await scanResult).error.message, /管理员授权已完成，但内存扫描未按时结束/)
  assert.ok(scan.statuses.some(entry => /授权已完成/.test(entry.message)))
  assert.ok(scan.statuses.some(entry => /只读扫描/.test(entry.message)))
  scan.assertClean()

  const rejected = macFixture()
  const declined = rejected.mac.autoGetDbKey(1000, rejected.onStatus)
  await tick()
  rejected.calls[0].resolve('WF_ERR::-128::用户已取消。')
  assert.match((await declined).error, /已取消管理员授权/)
  rejected.assertClean()

  for (const phase of ['authorization', 'scanning']) {
    const cancelled = macFixture()
    const parent = trackedController()
    const pending = outcome(cancelled.elevated(parent.controller.signal))
    if (phase === 'scanning') {
      cancelled.progress('scanning')
      await cancelled.clock.advance(250)
    }
    parent.controller.abort(new Error('synthetic cancellation'))
    assert.equal(cancelled.calls[0].options.signal.aborted, true, 'cancellation must immediately reach the child process')
    assert.match((await pending).error.message, /synthetic cancellation/)
    assert.equal(parent.listenerCount(), 0)
    const statusCount = cancelled.statuses.length
    cancelled.calls[0].resolve(`WF_OK::${key}`)
    await cancelled.clock.advance(100_000)
    assert.equal(cancelled.statuses.length, statusCount, 'late child output cannot emit progress after cleanup')
    cancelled.assertClean()
  }

  const disposed = macFixture()
  const pendingDispose = disposed.mac.autoGetDbKey(1000, disposed.onStatus)
  await tick()
  disposed.mac.dispose()
  assert.equal(disposed.calls[0].options.signal.aborted, true)
  assert.match((await pendingDispose).error, /取消/)
  disposed.assertClean()

  for (const [stage, extra, response, expected] of [
    ['timeout', {}, 'WF_OK::', /扫描时限内未找到候选密钥/],
    ['timeout', { candidates: 2 }, 'WF_OK::not-a-key', /扫描已找到候选，但读取组件返回的结果无法解析/],
    ['error', { errorCode: 'ATTACH_DENIED' }, 'WF_ERR::1::ERROR:ATTACH', /管理员授权已完成，但系统仍阻止读取微信进程/],
    ['cancelled', { candidates: 1 }, `WF_OK::${key}`, /已取消获取密钥/],
  ]) {
    const app = macFixture()
    const result = outcome(app.elevated())
    app.progress(stage, extra)
    app.calls[0].resolve(response)
    assert.match((await result).error.message, expected)
    app.assertClean()
  }

  // The legacy scanner remains a low-level utility; parsing a candidate is
  // not account verification. The macOS IPC now uses validated login capture.
  // AppleScript can turn LF from do shell script into bare CR. Accept all line
  // endings, even when helper progress already reports usable candidates.
  const secondKey = 'b2'.repeat(32)
  for (const [lineEnding, separators] of [
    ['bare CR', ['\r', '\r', '\r', '\r']],
    ['CRLF', ['\r\n', '\r\n', '\r\n', '\r\n']],
    ['LF', ['\n', '\n', '\n', '\n']],
    ['mixed', ['\r', '\r\n', '\n', '\r']],
  ]) {
    const partial = macFixture()
    const partialResult = partial.mac.autoGetDbKey(1000, partial.onStatus)
    await tick()
    partial.progress('timeout', { candidates: 2, key, details: secondKey })
    const lines = [key, secondKey.toUpperCase(), key, secondKey, 'not-a-key']
    const payload = lines.map((line, index) => line + (separators[index] || '')).join('')
    partial.calls[0].resolve(`WF_OK::${payload}`)
    const verified = await partialResult
    assert.equal(verified.success, true, `${lineEnding}: partial candidates must survive AppleScript line endings`)
    assert.equal(verified.key, key, `${lineEnding}: scanner results are unverified candidates`)
    assert.deepEqual(Array.from(verified.candidates), [key, secondKey], `${lineEnding}: normalize case and deduplicate parsed candidates`)
    assert.ok(partial.statuses.some(entry => /扫描时间已到/.test(entry.message)))
    for (const secret of [key, secondKey]) assert.equal(JSON.stringify(partial.statuses).includes(secret), false)
    partial.assertClean()
  }
}

async function main() {
  const ready = { platform: 'win32', arch: 'x64', running: true, componentReady: true, database: 'ready' }
  assert.equal(shared.buildWechatPreflight(ready).canAutoGet, true)
  assert.equal(shared.buildWechatPreflight({ ...ready, platform: 'linux' }).canAutoGet, false)
  assert.equal(shared.buildWechatPreflight({ ...ready, arch: 'arm64' }).canAutoGet, false)
  assert.equal(shared.buildWechatPreflight({ ...ready, componentReady: false }).canAutoGet, false)
  assert.equal(shared.buildWechatPreflight({ ...ready, database: 'unreadable' }).canAutoGet, false)
  assert.equal(shared.buildWechatPreflight({ ...ready, platform: 'darwin', security: 'unknown' }).canAutoGet, false)
  assert.equal(shared.parseMacSipStatus('System Integrity Protection status: enabled.'), 'enabled')
  assert.equal(shared.parseMacSipStatus('System Integrity Protection status: disabled.'), 'disabled')
  assert.equal(shared.parseMacSipStatus('System Integrity Protection status: unknown (Custom Configuration).'), 'unknown')
  assert.equal(shared.redactWechatKey(new Error(`failed ${key}`)), 'failed [密钥已隐藏]')
  assert.equal(shared.isWechatDatabaseKey('x'.repeat(64)), false)
  assert.equal(shared.isWechatDatabaseKey(key), true)

  for (const options of [{ platform: 'linux' }, { platform: 'darwin' }, { running: false }]) {
    const app = fixture(options)
    assert.equal((await app.preflight()).canAutoGet, false)
    assert.equal((await app.start()).success, false)
    assert.equal(app.stats().scans, 0, 'blocked preflight must never start a native scan')
    assert.equal(app.stats().prohibitedActions, 0)
    assertNoAcquisitionListeners(app.sender)
  }

  let finishValidation
  const cancelled = fixture({ validate: () => new Promise(resolve => { finishValidation = resolve }) })
  const pending = cancelled.start()
  await tick()
  assert.equal(cancelled.stats().validations, 1)
  await cancelled.cancel()
  const progressAtCancel = cancelled.statuses.length
  assert.equal((await cancelled.start()).success, false, 'a pending native operation must not overlap a retry')
  finishValidation({ success: true })
  assert.equal((await pending).cancelled, true, 'a late validated key must never be returned after cancellation')
  assert.equal(cancelled.statuses.length, progressAtCancel)
  assertNoAcquisitionListeners(cancelled.sender)

  let finishScan
  const closed = fixture({ scan: () => new Promise(resolve => { finishScan = resolve }) })
  const pendingScan = closed.start()
  await tick()
  closed.sender.emit('destroyed')
  finishScan(account)
  assert.equal((await pendingScan).cancelled, true)
  assert.equal(closed.stats().validations, 0, 'closing the window must stop subsequent validation')
  assertNoAcquisitionListeners(closed.sender)

  // Full document reloads preserve WebContents, so destroyed alone is not
  // sufficient. Both modern event details and older positional signatures work.
  const abandonedDocuments = [
    sender => sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'http://localhost:5173/' }),
    sender => sender.emit('did-start-navigation', {}, 'http://localhost:5173/', false, true, 1, 1),
    sender => sender.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 }),
  ]
  for (const platform of ['win32', 'darwin']) {
    for (const abandonDocument of abandonedDocuments) {
      let nativeSignal
      let completeNative
      let lateStatus
      let nativeCalls = 0
      const nativeResult = platform === 'darwin' ? { success: true, key, validatedWxid: 'wxid_test' } : account
      const pendingNativeScan = (signal, onStatus) => {
        nativeCalls++
        nativeSignal = signal
        lateStatus = onStatus
        if (nativeCalls > 1) return nativeResult
        return new Promise(resolve => { completeNative = resolve })
      }
      const app = fixture({ platform, sip: false, scan: pendingNativeScan, macScan: pendingNativeScan })
      const abandoned = app.start()
      await tick()
      assert.equal(nativeSignal.aborted, false)
      abandonDocument(app.sender)
      assert.equal(nativeSignal.aborted, true, `${platform}: abandoning the document must immediately signal the native scan`)
      const statusesBeforeLateCallback = app.statuses.length
      lateStatus?.('late native status', 0)
      assert.equal((await app.start()).success, false, 'a new document must wait for the previous native cleanup, not overlap it')
      assert.equal(nativeCalls, 1)
      completeNative(nativeResult)
      const abandonedResult = await abandoned
      assert.equal(abandonedResult.cancelled, true)
      assert.equal(abandonedResult.key, undefined, 'an abandoned caller must never receive a late key')
      assert.equal(app.stats().validations, 0, 'an abandoned native scan must not begin database validation')
      assert.equal(app.statuses.length, statusesBeforeLateCallback, 'native progress cannot leak into the new document')
      assertNoAcquisitionListeners(app.sender)
      assert.equal((await app.start()).success, true, 'safe retry becomes available once the old operation has settled')
      assert.equal(nativeCalls, 2)
      assertNoAcquisitionListeners(app.sender)
      assert.equal(app.stats().prohibitedActions, 0)
    }
  }

  for (const harmlessNavigation of [
    sender => sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true, url: 'http://localhost:5173/#setup' }),
    sender => sender.emit('did-start-navigation', {}, 'http://localhost:5173/#setup', true, true, 1, 1),
    sender => sender.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false }),
    sender => sender.emit('did-start-navigation', {}, 'about:blank', false, false, 1, 2),
    // Current event details take precedence over deprecated positional fields.
    sender => sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true }, 'http://localhost:5173/#setup', false, true),
  ]) {
    let nativeSignal
    let completeNative
    const app = fixture({ scan: signal => {
      nativeSignal = signal
      return new Promise(resolve => { completeNative = resolve })
    } })
    const stillActive = app.start()
    await tick()
    harmlessNavigation(app.sender)
    assert.equal(nativeSignal.aborted, false, 'same-document/history/hash or subframe navigation must not cancel the active document')
    completeNative(account)
    assert.equal((await stillActive).success, true)
    assert.equal(app.stats().validations, 1)
    assertNoAcquisitionListeners(app.sender)
  }

  const success = fixture()
  assert.equal((await success.start()).key, key)
  assert.equal(success.stats().prohibitedActions, 0, 'successful acquisition never launches or kills WeChat')
  assertNoAcquisitionListeners(success.sender)

  const noDiagnostics = await fixture({ noKey: true }).start()
  assert.equal(noDiagnostics.success, false)
  assert.equal(noDiagnostics.needAdmin, undefined, 'missing diagnostics are not evidence of a permission failure')
  const permission = await fixture({ noKey: true, diag: { auth: true, dbOk: true, pids: 1, opened: 0, bytes: 0 } }).start()
  assert.equal(permission.needAdmin, true)

  const failed = fixture({ scan: async () => { throw new Error(`raw key: ${key}`) } })
  assert.equal((await failed.start()).error.includes(key), false)
  assert.equal(JSON.stringify(failed.logs).includes(key), false, 'raw native errors must not write keys to logs')
  assertNoAcquisitionListeners(failed.sender)

  const progressRedaction = fixture({ platform: 'darwin', sip: false, macScan: async (_signal, onStatus) => {
    onStatus(`synthetic native status: ${key}`, 0)
    return { success: true, key, validatedWxid: 'wxid_test' }
  } })
  assert.equal((await progressRedaction.start()).success, true)
  assert.equal(JSON.stringify(progressRedaction.statuses).includes(key), false, 'IPC progress independently redacts raw native keys')
  assert.ok(progressRedaction.statuses.some(entry => entry.status.includes('[密钥已隐藏]')))
  assertNoAcquisitionListeners(progressRedaction.sender)

  const noRuntime = fixture({ platform: 'darwin', sip: false, runtimeReady: false })
  assert.equal((await noRuntime.preflight()).canAutoGet, false)
  assert.equal((await noRuntime.start()).success, false)
  assert.equal(noRuntime.stats().scans, 0)
  const unverifiedCapture = fixture({ platform: 'darwin', sip: false, macScan: async () => ({ success: true, key }) })
  assert.equal((await unverifiedCapture.start()).success, false, 'a capture without account validation must not reach the renderer')
  let selectedAccount
  const selectedCapture = fixture({ platform: 'darwin', sip: false, macScan: async (_signal, _onStatus, wxid) => {
    selectedAccount = wxid
    return { success: true, key, validatedWxid: wxid }
  } })
  assert.equal((await selectedCapture.start('selected-account')).validatedWxid, 'selected-account')
  assert.equal(selectedAccount, 'selected-account')
  assert.equal(selectedCapture.stats().validations, 0, 'a login capture must not short circuit through an old active database connection')
  let finishCapture
  const cleanup = fixture({ platform: 'darwin', sip: false, macScan: () => new Promise(resolve => { finishCapture = resolve }) })
  const captureRun = cleanup.start()
  await tick()
  let cancelAcknowledged = false
  const cancellation = cleanup.cancel().then(() => { cancelAcknowledged = true })
  await tick()
  assert.equal(cancelAcknowledged, false, 'macOS cancellation must await debugger cleanup')
  finishCapture({ success: true, key, validatedWxid: 'wxid_test' })
  await cancellation
  const cancelledCapture = await captureRun
  assert.equal(cancelledCapture.cancelled, true)
  assert.equal(cancelledCapture.key, undefined)
  assertNoAcquisitionListeners(cleanup.sender)

  await checkMacAcquisitionStages()
  await checkLocalMachChunks()

  let nativeComplete
  let freed = 0
  const scanFunction = () => {}
  scanFunction.async = (...args) => { nativeComplete = args.at(-1) }
  const { WxKeyService } = loadTs('electron/services/wxKeyService.ts', {
    child_process: {}, path, electron: { app: {} }, fs: {},
    crypto: { sign: () => Buffer.alloc(64) }, util: require('node:util'),
    koffi: { decode: () => { throw new Error('cancelled key must not be decoded') } },
    '../../src/shared/wechatConnection': shared,
  }, { Buffer, console })
  const windows = new WxKeyService()
  windows.initScanLib = () => true
  windows.getScanPrivateKey = () => 'mock-private-key'
  windows.scanLib = { func: declaration => declaration.includes('wkt_challenge') ? () => 32
    : declaration.includes('wkt_free') ? () => { freed++ } : scanFunction }
  const stop = new AbortController()
  const pendingNative = windows.scanAccountAsync(stop.signal)
  stop.abort()
  windows.dispose()
  nativeComplete(null, 'mock-native-pointer')
  await assert.rejects(pendingNative, /abort/i)
  assert.equal(freed, 1, 'a late native allocation must be freed even after dispose')
  console.log('WeChat preflight, stage-specific deadlines, bounded Mach reads, cross-chunk candidates, partial-candidate validation, cancellation cleanup and progress/key-redaction checks passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
