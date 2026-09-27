'use strict'

// Synthetic memory and injected WinAPI only. This is not a Windows integration test.
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { spawnSync, fork } = require('node:child_process')
const path = require('node:path')
const workerPath = path.join(__dirname, '../resources/windows/wechat-key-scan.cjs')
const scanner = require(workerPath)
const {
  CandidateStream, CHUNK_BYTES, MAX_CANDIDATES, MAX_SALTS, SCAN_ACCESS,
  validateRequest, readableRegion, iterateProcessMemory, runScan, createNativeApi,
  createWindowsTypes, startWorker,
} = scanner
const key = 'a1'.repeat(32)
const key2 = 'b2'.repeat(32)
const salt = 'c3'.repeat(16)
const salt2 = 'd4'.repeat(16)
const literal = (k = key, s = salt) => Buffer.from(`x'${k}${s}'`, 'ascii')
const request = { type: 'scan', salts: [salt, salt2], timeoutMs: 1000 }
const tests = []
function test(name, run) { tests.push({ name, run }) }

function fakeApi(config = {}) {
  const entries = config.entries || [{ pid: 10, parentPid: 1, name: 'Weixin.exe' }]
  const contents = config.contents || new Map([[10, literal()]])
  const closed = [], opened = [], reads = [], queried = []
  const api = {
    minAddress: 0n, maxAddress: config.maxAddress ?? 0x1000000000n, pageSize: config.pageSize || 4096,
    listProcesses: () => entries,
    openProcess(pid, access) { opened.push([pid, access]); return config.deny?.has(pid) ? null : { pid } },
    closeHandle(handle) { closed.push(handle.pid) },
    lastError: () => 5,
    getProcessImage: handle => config.images?.get(handle.pid)
      || `C:\\Program Files\\Tencent\\Weixin\\${entries.find(entry => entry.pid === handle.pid).name}`,
    queryRegion(handle, address) {
      queried.push([handle.pid, address])
      if (config.queryRegion) return config.queryRegion(handle, address)
      const size = BigInt(contents.get(handle.pid)?.length || 0)
      return address < size ? { base: 0n, size, state: 0x1000, protect: 0x04 } : null
    },
    readMemory(handle, address, requested) {
      reads.push({ pid: handle.pid, address, requested })
      if (config.readMemory) return config.readMemory(handle, address, requested)
      const buffer = Buffer.from((contents.get(handle.pid) || Buffer.alloc(0)).subarray(Number(address), Number(address) + requested))
      return { buffer, nread: buffer.length }
    },
  }
  return { api, closed, opened, reads, queried }
}

async function collectRun(mock, options = {}, message = request) {
  const messages = []
  const outcome = await runScan(message, mock.api, { emit: value => messages.push(value), ...options })
  return { outcome, messages, candidates: messages.filter(value => value.type === 'candidate') }
}

test('import and direct invocation do not scan, print secrets, or load kernel32', () => {
  const result = spawnSync(process.execPath, [workerPath], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})

test('request whitelist, salt normalization, and strict bounds', () => {
  assert.deepEqual([...validateRequest({ ...request, salts: [salt.toUpperCase(), salt] }).salts], [salt])
  for (const value of [null, {}, [], { ...request, type: 'write' }, { ...request, salts: [] },
    { ...request, salts: [key] }, { ...request, salts: [1] }, { ...request, salts: ['g'.repeat(32)] },
    { ...request, salts: Array(MAX_SALTS + 1).fill(salt) }, { ...request, timeoutMs: 120001 },
    { ...request, timeoutMs: 0 }, { ...request, timeoutMs: 1.5 }, { ...request, timeoutMs: NaN },
    { ...request, pid: 1 }]) {
    assert.throws(() => validateRequest(value), { code: 'INVALID_REQUEST' })
  }
})

test('literal matching across every split, one-byte chunks, and arbitrary preceding bytes', () => {
  const raw = literal()
  for (let split = 0; split <= raw.length; split++) {
    const values = []
    const stream = new CandidateStream(new Set([salt]), value => values.push(value))
    stream.feed(raw.subarray(0, split))
    stream.feed(raw.subarray(split))
    assert.deepEqual(values, [{ key, salt }])
    stream.reset()
  }
  for (const prefix of ['', ...Array.from({ length: 256 }, (_, byte) => String.fromCharCode(byte))]) {
    const values = []
    const stream = new CandidateStream(new Set([salt]), value => values.push(value))
    for (const byte of Buffer.concat([Buffer.from(prefix, 'latin1'), raw])) stream.feed(Buffer.from([byte]))
    assert.equal(values.length, 1)
    assert.ok(stream.tail.length <= 98)
    stream.reset()
  }
})

test('salt whitelist, case folding, pair deduplication, and ASCII-only matching', () => {
  const values = [], seen = new Set()
  const stream = new CandidateStream(new Set([salt, salt2]), value => values.push(value), seen)
  const data = Buffer.concat([
    literal(), Buffer.from('!'), literal(key.toUpperCase(), salt.toUpperCase()), Buffer.from('!'),
    literal(key, salt2), Buffer.from('!'), literal(key2, salt), Buffer.from('!'),
    literal(key, 'ee'.repeat(16)), Buffer.from(`!x'${key}${salt}'!`, 'utf16le'),
    Buffer.from(`!x'${key}'!x'${key}${salt}a'!${key}${salt}!`),
  ])
  stream.feed(data)
  assert.deepEqual(values, [{ key, salt }, { key, salt: salt2 }, { key: key2, salt }])
  const other = new CandidateStream(new Set([salt]), value => values.push(value), seen)
  other.feed(literal())
  assert.equal(values.length, 3)
  stream.reset(); other.reset()
})

test('bounded candidate storage and gap reset', () => {
  const values = []
  const stream = new CandidateStream(new Set([salt]), value => values.push(value))
  for (let i = 0; i < MAX_CANDIDATES + 3; i++) stream.feed(Buffer.concat([
    Buffer.from('!'), literal(i.toString(16).padStart(64, '0')),
  ]))
  assert.equal(values.length, MAX_CANDIDATES)
  assert.equal(stream.seen.size, MAX_CANDIDATES)
  const split = new CandidateStream(new Set([salt]), () => assert.fail('Must not join across a gap'))
  split.feed(literal().subarray(0, 30)); split.reset(); split.feed(literal().subarray(30)); split.reset()
  stream.reset()
})

test('only committed readable non-guard pages qualify', () => {
  for (const protect of [2, 4, 8, 0x20, 0x40, 0x80, 0x204]) assert.equal(readableRegion({ state: 0x1000, protect }), true)
  for (const protect of [0, 1, 0x10, 0x104, 0x140]) assert.equal(readableRegion({ state: 0x1000, protect }), false)
  assert.equal(readableRegion({ state: 0x2000, protect: 4 }), false)
})

test('1 MiB reads detect split literals and wipe read buffers', async () => {
  const data = Buffer.alloc(CHUNK_BYTES + 512, 33)
  literal().copy(data, CHUNK_BYTES - 49)
  const buffers = []
  const mock = fakeApi({ contents: new Map([[10, data]]), readMemory(handle, address, requested) {
    const buffer = Buffer.from(data.subarray(Number(address), Number(address) + requested))
    buffers.push(buffer)
    return { buffer, nread: buffer.length }
  } })
  const result = await collectRun(mock)
  assert.equal(result.outcome.reason, 'complete')
  assert.equal(result.candidates.length, 1)
  assert.ok(mock.reads.every(read => read.requested <= CHUNK_BYTES))
  assert.deepEqual(mock.reads.map(read => read.address), [0n, BigInt(CHUNK_BYTES)])
  assert.equal(result.messages.at(-2).scannedBytes, data.length)
  assert.ok(buffers.every(buffer => buffer.every(byte => byte === 0)))
  assert.deepEqual(mock.closed, [10])
})

test('positive partial reads advance by nread, preserving the remaining bytes', async () => {
  const data = Buffer.concat([Buffer.alloc(8, 33), literal(), Buffer.alloc(19, 33)])
  const mock = fakeApi({ contents: new Map([[10, data]]), readMemory(handle, address, requested) {
    const nread = Math.min(requested, 17)
    const buffer = Buffer.alloc(requested, 0)
    data.copy(buffer, 0, Number(address), Number(address) + nread)
    return { buffer, nread, ok: false }
  } })
  const result = await collectRun(mock)
  assert.equal(result.candidates.length, 1)
  assert.deepEqual(mock.reads.slice(0, 3).map(read => read.address), [0n, 17n, 34n])
  assert.equal(result.messages.at(-2).scannedBytes, data.length)
})

test('zero-byte failures retry one page and do not skip the rest of a large region', async () => {
  const data = Buffer.alloc(3 * 4096, 33)
  literal().copy(data, 2 * 4096)
  const mock = fakeApi({ contents: new Map([[10, data]]), readMemory(handle, address, requested) {
    if (address < 8192n) return { buffer: Buffer.alloc(requested), nread: 0 }
    const buffer = Buffer.from(data.subarray(Number(address), Number(address) + requested))
    return { buffer, nread: buffer.length }
  } })
  const result = await collectRun(mock)
  assert.equal(result.candidates.length, 1)
  assert.deepEqual(mock.reads.map(read => read.address), [0n, 0n, 4096n, 4096n, 8192n])
})

test('no concatenation across unreadable pages but contiguous readable regions work', async () => {
  for (const middleReadable of [false, true]) {
    const data = literal()
    const mock = fakeApi({ contents: new Map([[10, data]]), queryRegion(handle, address) {
      if (address >= 99n) return null
      return address < 50n ? { base: 0n, size: 50n, state: 0x1000, protect: 4 }
        : { base: 50n, size: 49n, state: 0x1000, protect: middleReadable ? 2 : 0x104 }
    } })
    const result = await collectRun(mock)
    assert.equal(result.candidates.length, middleReadable ? 1 : 0)
  }
})

test('round-robin scanning reaches other PIDs despite an enormous first region', async () => {
  let clock = 0
  const huge = 1n << 40n
  const mock = fakeApi({
    entries: [{ pid: 10, parentPid: 1, name: 'Weixin.exe' }, { pid: 11, parentPid: 1, name: 'Weixin.exe' }],
    maxAddress: huge,
    queryRegion(handle, address) {
      const size = handle.pid === 10 ? huge : 99n
      return address < size ? { base: 0n, size, state: 0x1000, protect: 4 } : null
    },
    readMemory(handle, address, requested) {
      clock += 10
      const buffer = Buffer.alloc(requested, 33)
      if (handle.pid === 11) literal().copy(buffer)
      return { buffer, nread: buffer.length }
    },
  })
  const result = await collectRun(mock, { now: () => clock }, { ...request, timeoutMs: 35 })
  assert.equal(result.outcome.reason, 'timeout')
  assert.deepEqual(mock.reads.slice(0, 2).map(read => read.pid), [10, 11])
  assert.equal(result.candidates.length, 1)
  assert.deepEqual(mock.closed, [10, 11])
})

test('only Weixin and verified AppEx descendants within the installation directory are read', async () => {
  const entries = [
    { pid: 10, parentPid: 1, name: 'Weixin.exe' },
    { pid: 11, parentPid: 10, name: 'WeChatAppEx.exe' },
    { pid: 12, parentPid: 11, name: 'WeChatAppEx.exe' },
    { pid: 13, parentPid: 10, name: 'WeChatAppEx.exe' },
    { pid: 14, parentPid: 1, name: 'WeChatAppEx.exe' },
    { pid: 15, parentPid: 10, name: 'WeChat.exe' },
    { pid: 16, parentPid: 1, name: 'Weixin.exe' },
    { pid: 17, parentPid: 18, name: 'WeChatAppEx.exe' },
    { pid: 18, parentPid: 17, name: 'WeChatAppEx.exe' },
    { pid: 19, parentPid: 13, name: 'WeChatAppEx.exe' },
  ]
  const images = new Map([
    [10, 'C:\\Weixin\\Weixin.exe'], [11, 'c:\\weixin\\4.0\\WeChatAppEx.exe'],
    [12, 'C:\\Weixin\\4.0\\plugins\\WeChatAppEx.exe'],
    [13, 'C:\\Weixin-other\\WeChatAppEx.exe'], [16, 'C:\\Other\\Unrelated.exe'],
    [19, 'C:\\Weixin\\WeChatAppEx.exe'],
  ])
  const mock = fakeApi({ entries, images, contents: new Map(entries.map(entry => [entry.pid, literal()])) })
  const result = await collectRun(mock)
  assert.deepEqual([...new Set(mock.reads.map(read => read.pid))], [10, 11, 12])
  assert.ok(mock.opened.every(([, access]) => access === SCAN_ACCESS && access === 0x410))
  assert.deepEqual(mock.closed, mock.opened.map(([pid]) => pid))
  assert.equal(result.candidates.length, 1)
  assert.equal(result.messages.at(-2).opened, 3)
})

test('empty snapshot, denied access, and exited/reused PID are distinguished', async () => {
  for (const [config, reason] of [
    [{ entries: [] }, 'no-process'], [{ deny: new Set([10]) }, 'permission-denied'],
    [{ images: new Map([[10, 'C:\\Other\\Else.exe']]) }, 'no-process'],
  ]) {
    const mock = fakeApi(config)
    const result = await collectRun(mock)
    assert.equal(result.outcome.reason, reason)
    assert.equal(mock.reads.length, 0)
  }
})

test('cancellation and timeout release handles and suppress late candidates', async () => {
  for (const reason of ['cancel', 'timeout']) {
    let stopped = false
    const mock = fakeApi({ readMemory(handle, address, requested) {
      stopped = true
      return { buffer: literal(), nread: 99 }
    } })
    const result = await collectRun(mock, {
      now: () => reason === 'timeout' && stopped ? 1000 : 0,
      isCancelled: () => reason === 'cancel' && stopped,
    })
    assert.deepEqual(result.outcome, reason === 'cancel'
      ? { type: 'error', code: 'CANCELLED' } : { type: 'done', reason: 'timeout' })
    assert.equal(result.candidates.length, 0)
    assert.deepEqual(mock.closed, [10])
  }
})

test('unexpected native and callback errors are sanitized and close every handle', async () => {
  for (const step of ['getProcessImage', 'queryRegion', 'readMemory']) {
    const mock = fakeApi()
    mock.api[step] = () => { throw new Error(`PRIVATE_PATH_AND_KEY_${key}`) }
    const result = await collectRun(mock)
    assert.deepEqual(result.outcome, { type: 'error', code: 'SCAN_FAILED' })
    assert.ok(!JSON.stringify(result.messages).includes('PRIVATE'))
    assert.ok(!JSON.stringify(result.messages).includes(key))
    assert.deepEqual(mock.closed, [10])
  }
  const mock = fakeApi()
  const messages = []
  await runScan(request, mock.api, { emit(value) {
    if (value.type === 'candidate') throw new Error('PRIVATE_CALLBACK')
    messages.push(value)
  } })
  assert.deepEqual(messages.at(-1), { type: 'error', code: 'SCAN_FAILED' })
  assert.deepEqual(mock.closed, [10])
})

test('malformed region/read sizes cannot loop or expose unread buffer bytes', async () => {
  for (const config of [
    { queryRegion: () => ({ base: 0n, size: 0n, state: 0x1000, protect: 4 }) },
    { readMemory: () => ({ buffer: literal(), nread: 1000 }) },
    { readMemory: () => ({ buffer: literal(), nread: -1 }) },
  ]) {
    const mock = fakeApi(config)
    const result = await collectRun(mock)
    assert.equal(result.outcome.code, 'SCAN_FAILED')
    assert.equal(result.candidates.length, 0)
    assert.deepEqual(mock.closed, [10])
  }
})

test('32-bit worker is rejected before loading any library', () => {
  assert.throws(() => createNativeApi({ platform: 'win32', arch: 'ia32', loadKoffi: () => assert.fail('must not load') }), { code: 'UNSUPPORTED_ARCH' })
  assert.throws(() => createWindowsTypes({ sizeof: () => 4 }), { code: 'UNSUPPORTED_ARCH' })
})

test('documented x64/arm64 structure sizes and offsets match real Koffi 2.x', () => {
  const koffi = require('koffi')
  const types = createWindowsTypes(koffi)
  assert.equal(koffi.sizeof(types.memory), 48)
  assert.equal(koffi.offsetof(types.memory, 'RegionSize'), 24)
  assert.equal(koffi.sizeof(types.processEntry), 568)
  assert.equal(koffi.offsetof(types.processEntry, 'szExeFile'), 44)
  assert.equal(koffi.sizeof(types.systemInfo), 48)
})

function mockNative(options = {}) {
  const koffi = require('koffi')
  const calls = [], closed = []
  const functions = {
    OpenProcess: (access, inherit, pid) => { calls.push(['open', access, inherit, pid]); return 50n },
    CloseHandle: handle => { closed.push(handle); return 1 },
    GetLastError: () => options.error || 18,
    CreateToolhelp32Snapshot: (flags, pid) => {
      calls.push(['snapshot', flags, pid])
      return options.invalidSnapshot ? koffi.decode(Buffer.alloc(8, 255), 'void *') : 44n
    },
    Process32FirstW: (handle, buffer) => {
      assert.equal(buffer.readUInt32LE(0), 568)
      if (options.snapshotError) throw Error('PRIVATE_NATIVE_EXCEPTION')
      buffer.writeUInt32LE(10, 8); buffer.writeUInt32LE(1, 32)
      Buffer.from('Weixin.exe\0', 'utf16le').copy(buffer, 44)
      return 1
    },
    Process32NextW: () => 0,
    QueryFullProcessImageNameW: (handle, flags, buffer, size) => {
      const image = 'C:\\Weixin\\Weixin.exe'
      assert.equal(size[0], 32768)
      Buffer.from(`${image}\0`, 'utf16le').copy(buffer)
      size[0] = image.length
      return 1
    },
    VirtualQueryEx: (handle, address, buffer, length) => {
      assert.equal(length, 48)
      buffer.writeBigUInt64LE(address, 0)
      buffer.writeBigUInt64LE(4096n, 24)
      buffer.writeUInt32LE(0x1000, 32)
      buffer.writeUInt32LE(4, 36)
      return 48
    },
    ReadProcessMemory: (handle, address, buffer, size, read) => {
      literal().copy(buffer); read[0] = 99
      return 0 // ERROR_PARTIAL_COPY: nread remains authoritative.
    },
    GetNativeSystemInfo: buffer => {
      buffer.writeUInt32LE(4096, 4)
      buffer.writeBigUInt64LE(65536n, 8)
      buffer.writeBigUInt64LE(0x7ffffffeffffn, 16)
    },
  }
  const api = createNativeApi({ platform: 'win32', arch: 'x64', loadKoffi: () => ({
    ...koffi,
    load(name) {
      assert.equal(name, 'kernel32.dll')
      return { func(prototype) {
        const name = prototype.match(/__stdcall\s+(\w+)\(/)[1]
        assert.ok(functions[name], `Unexpected native API: ${name}`)
        calls.push(['function', name])
        return functions[name]
      } }
    },
  }) })
  return { api, calls, closed }
}

test('native adapter uses Toolhelp, UTF-16 identity, pointer-width structs, and partial nread', () => {
  const { api, calls, closed } = mockNative()
  assert.deepEqual(api.listProcesses(), [{ pid: 10, parentPid: 1, name: 'Weixin.exe' }])
  assert.deepEqual(closed, [44n])
  assert.equal(api.minAddress, 65536n)
  assert.equal(api.maxAddress, 0x7ffffffeffffn)
  assert.equal(api.getProcessImage(50n), 'C:\\Weixin\\Weixin.exe')
  assert.deepEqual(api.queryRegion(50n, 0x100000000n), { base: 0x100000000n, size: 4096, state: 0x1000, protect: 4 })
  const read = api.readMemory(50n, 0x100000000n, 4096)
  assert.equal(read.nread, 99)
  assert.deepEqual(read.buffer.subarray(0, 99), literal())
  read.buffer.fill(0)
  assert.ok(calls.some(call => call[0] === 'snapshot' && call[1] === 2 && call[2] === 0))
  assert.ok(!calls.some(call => /Write|Debug|Protect|Thread/.test(call[1])))
})

test('snapshot handle closes on enumeration error and invalid handles never close', () => {
  const first = mockNative({ snapshotError: true })
  assert.throws(() => first.api.listProcesses())
  assert.deepEqual(first.closed, [44n])
  const second = mockNative({ invalidSnapshot: true })
  assert.throws(() => second.api.listProcesses(), { code: 'ENUMERATION_FAILED' })
  assert.deepEqual(second.closed, [])
})

test('enumeration cancellation and timeout stop before opening processes', async () => {
  for (const reason of ['cancel', 'timeout']) {
    let stopped = false
    const mock = fakeApi()
    const enumerate = mock.api.listProcesses
    mock.api.listProcesses = () => { stopped = true; return enumerate() }
    const result = await collectRun(mock, {
      now: () => reason === 'timeout' && stopped ? 1000 : 0,
      isCancelled: () => reason === 'cancel' && stopped,
    })
    assert.deepEqual(result.outcome, reason === 'cancel'
      ? { type: 'error', code: 'CANCELLED' } : { type: 'done', reason: 'timeout' })
    assert.equal(mock.opened.length, 0)
    assert.equal(mock.reads.length, 0)
  }
  const native = mockNative()
  assert.deepEqual(native.api.listProcesses(() => true), [])
  assert.deepEqual(native.closed, [44n])
})

test('each acquired process handle closes even if closing another throws', async () => {
  const mock = fakeApi({ entries: [
    { pid: 10, parentPid: 1, name: 'Weixin.exe' },
    { pid: 11, parentPid: 1, name: 'Weixin.exe' },
  ] })
  const close = mock.api.closeHandle
  mock.api.closeHandle = handle => { close(handle); throw new Error('PRIVATE_CLOSE_ERROR') }
  const result = await collectRun(mock)
  assert.deepEqual(mock.closed, [10, 11])
  assert.equal(result.outcome.reason, 'complete')
})

test('worker IPC is one-shot, sanitizes invalid requests, and closes on cancellation', async () => {
  for (const scenario of ['complete', 'cancel', 'invalid']) {
    const channel = new EventEmitter()
    const messages = []
    channel.connected = true
    channel.send = (value, callback) => { messages.push(value); callback() }
    channel.disconnect = () => { channel.connected = false }
    const mock = fakeApi()
    startWorker(channel, () => mock.api)
    channel.emit('message', scenario === 'invalid' ? { ...request, key } : request)
    if (scenario === 'cancel') channel.emit('message', { type: 'cancel' })
    channel.emit('message', request) // No second scan.
    for (let i = 0; i < 20 && channel.connected; i++) await new Promise(resolve => setImmediate(resolve))
    assert.equal(channel.connected, false)
    assert.equal(channel.listenerCount('message'), 0)
    assert.equal(messages.filter(value => value.type === 'done' || value.type === 'error').length, 1)
    assert.equal(messages.at(-1)[scenario === 'complete' ? 'reason' : 'code'],
      scenario === 'complete' ? 'complete' : scenario === 'cancel' ? 'CANCELLED' : 'INVALID_REQUEST')
    assert.deepEqual(mock.closed, scenario === 'invalid' ? [] : [10])
  }
})

test('real fork on non-Windows emits only a fixed platform error without output', async () => {
  if (process.platform === 'win32') return
  const child = fork(workerPath, { silent: true })
  const messages = [], stdout = [], stderr = []
  child.on('message', message => messages.push(message))
  child.stdout.on('data', data => stdout.push(data))
  child.stderr.on('data', data => stderr.push(data))
  const finished = new Promise((resolve, reject) => {
    child.once('exit', code => code === 0 ? resolve() : reject(Error('worker exit')))
    child.once('error', reject)
  })
  child.send(request)
  await finished
  assert.deepEqual(messages, [{ type: 'error', code: 'UNSUPPORTED_PLATFORM' }])
  assert.equal(Buffer.concat(stdout).length, 0)
  assert.equal(Buffer.concat(stderr).length, 0)
})

;(async () => {
  for (const { name, run } of tests) {
    await run()
    console.log(`ok - ${name}`)
  }
  console.log(`Passed ${tests.length} synthetic Windows scanner tests; no live Windows process was inspected.`)
})().catch(error => { console.error(error); process.exitCode = 1 })
