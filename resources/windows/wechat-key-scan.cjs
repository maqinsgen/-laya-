'use strict'

// One-shot, read-only worker. Candidate secrets travel only over fork IPC.
// No key is printed, persisted, injected into WeChat, or included in an error.
const path = require('node:path').win32
const { performance } = require('node:perf_hooks')

const CHUNK_BYTES = 1024 * 1024
const OVERLAP_BYTES = 98 // x'<96 hex>' is 99 bytes long.
const MAX_TIMEOUT_MS = 120000
const MAX_SALTS = 4096
const MAX_CANDIDATES = 4096
const MAX_PROCESSES = 128
const MAX_SNAPSHOT_ENTRIES = 65536
const QUERY_INFORMATION = 0x0400
const VM_READ = 0x0010
// VirtualQueryEx requires QUERY_INFORMATION, which implies QUERY_LIMITED_INFORMATION.
const SCAN_ACCESS = QUERY_INFORMATION | VM_READ
const ERROR_CODES = new Set([
  'INVALID_REQUEST', 'UNSUPPORTED_PLATFORM', 'UNSUPPORTED_ARCH', 'ABI_MISMATCH',
  'NATIVE_LOAD_FAILED', 'ENUMERATION_FAILED', 'PROCESS_LIMIT', 'SCAN_FAILED', 'CANCELLED',
])

function failure(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function validateRequest(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || Object.keys(message).some(key => !['type', 'salts', 'timeoutMs'].includes(key))
    || message.type !== 'scan' || !Array.isArray(message.salts)
    || message.salts.length < 1 || message.salts.length > MAX_SALTS
    || !Number.isInteger(message.timeoutMs) || message.timeoutMs < 1
    || message.timeoutMs > MAX_TIMEOUT_MS
    || message.salts.some(salt => typeof salt !== 'string' || !/^[0-9a-f]{32}$/i.test(salt))) {
    throw failure('INVALID_REQUEST')
  }
  return { salts: new Set(message.salts.map(salt => salt.toLowerCase())), timeoutMs: message.timeoutMs }
}

// SQLCipher literals are candidates, never proof that a database key is valid.
// A surrounding byte may belong to a different allocation; the exact literal,
// salt whitelist, and parent-side database verification establish candidacy.
class CandidateStream {
  constructor(salts, onCandidate, seen = new Set(), limit = MAX_CANDIDATES) {
    this.salts = salts
    this.onCandidate = onCandidate
    this.seen = seen
    this.limit = Math.min(MAX_CANDIDATES, Math.max(0, limit))
    this.tail = Buffer.alloc(0)
  }

  reset() {
    this.tail.fill(0)
    this.tail = Buffer.alloc(0)
  }

  feed(data) {
    if (!Buffer.isBuffer(data)) throw failure('SCAN_FAILED')
    const block = Buffer.concat([this.tail, data])
    this.tail.fill(0)
    try {
      // latin1 preserves high bytes; ascii decoding would clear their high bit.
      const text = block.toString('latin1')
      const expression = /[xX]'([0-9a-fA-F]{96})'/g
      for (let match = expression.exec(text); match; match = expression.exec(text)) {
        if (this.seen.size >= this.limit) break
        const raw = match[1].toLowerCase()
        const salt = raw.slice(64)
        if (!this.salts.has(salt) || this.seen.has(raw)) continue
        this.seen.add(raw)
        this.onCandidate({ key: raw.slice(0, 64), salt })
      }
      const start = Math.max(0, block.length - OVERLAP_BYTES)
      this.tail = Buffer.from(block.subarray(start))
    } finally {
      block.fill(0)
    }
  }
}

function readableRegion(region) {
  const protect = region.protect >>> 0
  return region.state === 0x1000 && !(protect & (0x100 | 0x01))
    && [0x02, 0x04, 0x08, 0x20, 0x40, 0x80].includes(protect & 0xff)
}

function bigint(value) {
  if (typeof value === 'bigint') return value
  if (Number.isSafeInteger(value)) return BigInt(value)
  throw failure('SCAN_FAILED')
}

// Yields one read (<=1 MiB) at a time, permitting round-robin scanning across PIDs.
// Positive partial reads advance by nread, even when ReadProcessMemory returned
// false. A failed zero-byte read retries within the current page before skipping
// that page, so an inaccessible page cannot hide the rest of a huge region.
function* iterateProcessMemory(api, handle, shouldStop = () => false) {
  let address = bigint(api.minAddress ?? 0n)
  const maxAddress = bigint(api.maxAddress)
  const pageSize = bigint(api.pageSize || 4096)
  if (pageSize <= 0n || maxAddress < address) throw failure('SCAN_FAILED')
  while (address <= maxAddress && !shouldStop()) {
    const region = api.queryRegion(handle, address)
    if (!region) return
    const base = bigint(region.base)
    const size = bigint(region.size)
    const end = base + size
    if (base > address || size <= 0n || end <= address) throw failure('SCAN_FAILED')
    if (!readableRegion(region)) {
      yield { type: 'gap' }
      address = end
      continue
    }
    yield { type: 'region' }
    while (address < end && address <= maxAddress && !shouldStop()) {
      const remaining = (end < maxAddress + 1n ? end : maxAddress + 1n) - address
      let requested = Number(remaining < BigInt(CHUNK_BYTES) ? remaining : BigInt(CHUNK_BYTES))
      let result = api.readMemory(handle, address, requested)
      let nread = Number(result.nread)
      const pageRemaining = Number(pageSize - address % pageSize)
      if (nread === 0 && requested > pageRemaining && !shouldStop()) {
        if (Buffer.isBuffer(result.buffer)) result.buffer.fill(0)
        requested = Math.min(requested, pageRemaining)
        result = api.readMemory(handle, address, requested)
        nread = Number(result.nread)
      }
      if (!Buffer.isBuffer(result.buffer) || !Number.isSafeInteger(nread)
        || nread < 0 || nread > requested || nread > result.buffer.length) {
        if (Buffer.isBuffer(result.buffer)) result.buffer.fill(0)
        throw failure('SCAN_FAILED')
      }
      if (nread > 0) {
        try {
          yield { type: 'block', address, data: result.buffer.subarray(0, nread) }
        } finally {
          result.buffer.fill(0)
        }
        address += BigInt(nread)
      } else {
        result.buffer.fill(0)
        yield { type: 'gap' }
        address += remaining < BigInt(pageRemaining) ? remaining : BigInt(pageRemaining)
      }
    }
  }
}

function normalizeImage(image) {
  if (typeof image !== 'string' || image.length > 32768 || image.includes('\0') || !path.isAbsolute(image)) return null
  return path.normalize(image.replace(/^\\\\\?\\/, '')).toLowerCase()
}

function isWithinDirectory(image, directory) {
  const relative = path.relative(directory, image)
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..\\')
}

// All handles stay open until scanning finishes, binding each PID to the same
// kernel process object even if the original process exits and its PID is reused.
function openTargets(api, entries, handles, shouldStop) {
  const named = new Map(entries.filter(entry => Number.isInteger(entry.pid) && entry.pid > 0
    && ['weixin.exe', 'wechatappex.exe'].includes(String(entry.name).toLowerCase()))
    .map(entry => [entry.pid, { ...entry, name: entry.name.toLowerCase() }]))
  if (named.size > MAX_PROCESSES) throw failure('PROCESS_LIMIT')
  const opened = new Map()
  let denied = 0
  let eligible = 0
  function rootFor(entry, trail = new Set()) {
    if (!entry || trail.has(entry.pid)) return null
    if (entry.name === 'weixin.exe') return entry
    trail.add(entry.pid)
    return rootFor(named.get(entry.parentPid), trail)
  }
  for (const entry of named.values()) {
    if (shouldStop()) break
    if (!rootFor(entry)) continue
    eligible++
    const handle = api.openProcess(entry.pid, SCAN_ACCESS)
    if (!handle) {
      if (api.lastError() === 5) denied++
      continue
    }
    handles.push(handle)
    const image = normalizeImage(api.getProcessImage(handle))
    // Validate against the snapshot before any memory read (PID reuse defense).
    if (!image || path.basename(image) !== entry.name) continue
    opened.set(entry.pid, { ...entry, image, handle })
  }
  function validRoot(entry, trail = new Set()) {
    if (!entry || trail.has(entry.pid)) return null
    if (entry.name === 'weixin.exe') return entry
    trail.add(entry.pid)
    const root = validRoot(opened.get(entry.parentPid), trail)
    return root && isWithinDirectory(entry.image, path.dirname(root.image)) ? root : null
  }
  return { targets: [...opened.values()].filter(entry => validRoot(entry)), denied, eligible }
}

/** Pure orchestration with an injected WinAPI adapter; safe to import on macOS. */
async function runScan(message, api, options = {}) {
  const { salts, timeoutMs } = validateRequest(message)
  const now = options.now || (() => performance.now())
  const cooperate = options.cooperate || (() => new Promise(resolve => setImmediate(resolve)))
  const emit = options.emit || (() => {})
  const isCancelled = options.isCancelled || (() => false)
  const deadline = now() + timeoutMs
  const stats = { regions: 0, scannedBytes: 0, candidates: 0, processes: 0, opened: 0 }
  const seen = new Set()
  const handles = []
  const scans = []
  let lastProgress = -Infinity
  let outcome
  function stopped() { return isCancelled() || now() >= deadline }
  function progress(force = false) {
    if (force || now() - lastProgress >= 250) {
      lastProgress = now()
      emit({ type: 'progress', ...stats })
    }
  }
  try {
    if (stopped()) outcome = { type: 'done', reason: 'timeout' }
    else {
      const entries = api.listProcesses(stopped)
      const { targets, denied, eligible } = openTargets(api, entries, handles, stopped)
      stats.processes = eligible
      stats.opened = targets.length
      for (const target of targets) {
        const stream = new CandidateStream(salts, candidate => {
          if (stopped()) return
          stats.candidates++
          emit({ type: 'candidate', ...candidate })
        }, seen)
        scans.push({ iterator: iterateProcessMemory(api, target.handle, stopped), stream, finished: false })
      }
      progress(true)
      let active = scans.length
      while (active && !stopped()) {
        for (const scan of scans) {
          if (scan.finished || stopped()) continue
          const result = scan.iterator.next()
          if (result.done) {
            scan.finished = true
            scan.stream.reset()
            active--
          } else if (result.value.type === 'region') stats.regions++
          else if (result.value.type === 'gap') scan.stream.reset()
          else {
            stats.scannedBytes += result.value.data.length
            try {
              if (!stopped()) scan.stream.feed(result.value.data)
            } finally {
              result.value.data.fill(0)
            }
          }
          progress()
        }
        await cooperate()
      }
      outcome = { type: 'done', reason: stopped() ? 'timeout'
        : !targets.length ? (denied ? 'permission-denied' : 'no-process') : 'complete' }
    }
    if (isCancelled()) outcome = { type: 'error', code: 'CANCELLED' }
  } catch (error) {
    outcome = { type: 'error', code: ERROR_CODES.has(error?.code) ? error.code : 'SCAN_FAILED' }
  } finally {
    for (const scan of scans) {
      try { scan.iterator.return() } catch { /* Release all other handles too. */ }
      scan.stream.reset()
    }
    for (const handle of handles) {
      try { api.closeHandle(handle) } catch { /* Never include native exception text. */ }
    }
    seen.clear()
    salts.clear()
  }
  progress(true)
  emit(outcome)
  return outcome
}

// Koffi 2 follows native C alignment. Use fixed-width Windows DWORD/LONG/WCHAR
// types (long and wchar_t differ on macOS), pointer-sized SIZE_T/ULONG_PTR, and
// assert offsets before loading native functions. Sources:
// https://koffi.dev/input (Koffi 2.x bundled doc/pages/input.md)
// https://koffi.dev/pointers
// https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-memory_basic_information
// https://learn.microsoft.com/en-us/windows/win32/api/tlhelp32/ns-tlhelp32-processentry32w
// https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/ns-sysinfoapi-system_info
function createWindowsTypes(koffi) {
  if (koffi.sizeof('void *') !== 8 || koffi.sizeof('size_t') !== 8) throw failure('UNSUPPORTED_ARCH')
  const memory = koffi.struct({
    BaseAddress: 'void *', AllocationBase: 'void *', AllocationProtect: 'uint32_t',
    PartitionId: 'uint16_t', RegionSize: 'size_t', State: 'uint32_t', Protect: 'uint32_t', Type: 'uint32_t',
  })
  const processEntry = koffi.struct({
    dwSize: 'uint32_t', cntUsage: 'uint32_t', th32ProcessID: 'uint32_t', th32DefaultHeapID: 'uintptr_t',
    th32ModuleID: 'uint32_t', cntThreads: 'uint32_t', th32ParentProcessID: 'uint32_t',
    pcPriClassBase: 'int32_t', dwFlags: 'uint32_t', szExeFile: koffi.array('uint16_t', 260),
  })
  const systemInfo = koffi.struct({
    dwOemId: 'uint32_t', dwPageSize: 'uint32_t', lpMinimumApplicationAddress: 'void *',
    lpMaximumApplicationAddress: 'void *', dwActiveProcessorMask: 'uintptr_t',
    dwNumberOfProcessors: 'uint32_t', dwProcessorType: 'uint32_t', dwAllocationGranularity: 'uint32_t',
    wProcessorLevel: 'uint16_t', wProcessorRevision: 'uint16_t',
  })
  if (koffi.sizeof(memory) !== 48 || koffi.offsetof(memory, 'RegionSize') !== 24
    || koffi.offsetof(memory, 'State') !== 32 || koffi.sizeof(processEntry) !== 568
    || koffi.offsetof(processEntry, 'th32DefaultHeapID') !== 16
    || koffi.offsetof(processEntry, 'szExeFile') !== 44 || koffi.sizeof(systemInfo) !== 48
    || koffi.offsetof(systemInfo, 'lpMaximumApplicationAddress') !== 16) throw failure('ABI_MISMATCH')
  return { memory, processEntry, systemInfo }
}

function createNativeApi({ platform = process.platform, arch = process.arch, loadKoffi = () => require('koffi') } = {}) {
  if (platform !== 'win32') throw failure('UNSUPPORTED_PLATFORM')
  if (!['x64', 'arm64'].includes(arch)) throw failure('UNSUPPORTED_ARCH')
  let koffi, types, kernel
  try {
    koffi = loadKoffi()
    types = createWindowsTypes(koffi)
    kernel = koffi.load('kernel32.dll')
  } catch (error) {
    throw failure(ERROR_CODES.has(error?.code) ? error.code : 'NATIVE_LOAD_FAILED')
  }
  const OpenProcess = kernel.func('void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)')
  const CloseHandle = kernel.func('int __stdcall CloseHandle(void *handle)')
  const GetLastError = kernel.func('uint32_t __stdcall GetLastError()')
  const Snapshot = kernel.func('void * __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)')
  const First = kernel.func('int __stdcall Process32FirstW(void *snapshot, _Inout_ void *entry)')
  const Next = kernel.func('int __stdcall Process32NextW(void *snapshot, _Inout_ void *entry)')
  const QueryImage = kernel.func('int __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, _Out_ uint16_t *name, _Inout_ uint32_t *size)')
  const QueryMemory = kernel.func('size_t __stdcall VirtualQueryEx(void *process, const void *address, _Out_ void *info, size_t length)')
  const ReadMemory = kernel.func('int __stdcall ReadProcessMemory(void *process, const void *address, _Out_ void *buffer, size_t size, _Out_ size_t *read)')
  const GetSystemInfo = kernel.func('void __stdcall GetNativeSystemInfo(_Out_ void *info)')
  // Koffi 2.x wraps pointers as External objects; address() returns their BigInt value.
  const pointerAddress = pointer => pointer == null ? 0n
    : typeof pointer === 'bigint' ? pointer : koffi.address(pointer)
  const systemBuffer = Buffer.alloc(koffi.sizeof(types.systemInfo))
  GetSystemInfo(systemBuffer)
  const system = koffi.decode(systemBuffer, types.systemInfo)
  return {
    minAddress: pointerAddress(system.lpMinimumApplicationAddress),
    maxAddress: pointerAddress(system.lpMaximumApplicationAddress),
    pageSize: system.dwPageSize,
    openProcess: (pid, access) => OpenProcess(access, 0, pid),
    closeHandle: handle => CloseHandle(handle),
    lastError: () => GetLastError(),
    listProcesses(shouldStop = () => false) {
      const snapshot = Snapshot(0x00000002, 0) // TH32CS_SNAPPROCESS only.
      const snapshotAddress = pointerAddress(snapshot)
      if (!snapshotAddress || snapshotAddress === -1n || snapshotAddress === 0xffffffffffffffffn) throw failure('ENUMERATION_FAILED')
      try {
        const buffer = Buffer.alloc(koffi.sizeof(types.processEntry))
        buffer.writeUInt32LE(buffer.length, 0)
        const entries = []
        let result = First(snapshot, buffer)
        while (result && !shouldStop()) {
          if (entries.length >= MAX_SNAPSHOT_ENTRIES) throw failure('PROCESS_LIMIT')
          const entry = koffi.decode(buffer, types.processEntry)
          const name = buffer.subarray(koffi.offsetof(types.processEntry, 'szExeFile')).toString('utf16le').split('\0')[0]
          entries.push({ pid: entry.th32ProcessID, parentPid: entry.th32ParentProcessID, name })
          result = Next(snapshot, buffer)
        }
        if (!result && GetLastError() !== 18) throw failure('ENUMERATION_FAILED') // ERROR_NO_MORE_FILES
        return entries
      } finally {
        CloseHandle(snapshot)
      }
    },
    getProcessImage(handle) {
      const buffer = Buffer.alloc(32768 * 2)
      const size = [32768]
      return QueryImage(handle, 0, buffer, size) && size[0] > 0 && size[0] < 32768
        ? buffer.subarray(0, size[0] * 2).toString('utf16le') : null
    },
    queryRegion(handle, address) {
      const buffer = Buffer.alloc(koffi.sizeof(types.memory))
      const bytes = Number(QueryMemory(handle, address, buffer, buffer.length))
      if (bytes === 0 && GetLastError() === 87) return null // ERROR_INVALID_PARAMETER: end of map.
      if (bytes !== buffer.length) throw failure('SCAN_FAILED')
      const value = koffi.decode(buffer, types.memory)
      return { base: pointerAddress(value.BaseAddress), size: value.RegionSize, state: value.State, protect: value.Protect }
    },
    readMemory(handle, address, size) {
      const buffer = Buffer.alloc(size)
      const read = [0]
      try {
        ReadMemory(handle, address, buffer, size, read)
        return { buffer, nread: read[0] }
      } catch {
        buffer.fill(0)
        throw failure('SCAN_FAILED')
      }
    },
  }
}

function startWorker(channel = process, nativeFactory = createNativeApi) {
  let started = false
  let cancelled = false
  function send(message) {
    if (!channel.connected || typeof channel.send !== 'function') return
    try { channel.send(message, () => {}) } catch { cancelled = true }
  }
  function cleanup() {
    channel.removeListener('message', onMessage)
    channel.removeListener('disconnect', cancel)
    channel.removeListener('SIGTERM', cancel)
    channel.removeListener('SIGINT', cancel)
    if (channel.connected) channel.disconnect()
  }
  function cancel() { cancelled = true; if (!started) cleanup() }
  async function onMessage(message) {
    if (message?.type === 'cancel') { cancel(); return }
    if (started) return
    started = true
    try {
      validateRequest(message)
      const api = nativeFactory()
      await runScan(message, api, { emit: send, isCancelled: () => cancelled })
    } catch (error) {
      send({ type: 'error', code: ERROR_CODES.has(error?.code) ? error.code : 'SCAN_FAILED' })
    } finally {
      cleanup()
    }
  }
  channel.on('message', onMessage)
  channel.on('disconnect', cancel)
  channel.on('SIGTERM', cancel)
  channel.on('SIGINT', cancel)
}

module.exports = {
  CHUNK_BYTES, OVERLAP_BYTES, MAX_TIMEOUT_MS, MAX_SALTS, MAX_CANDIDATES, SCAN_ACCESS,
  validateRequest, CandidateStream, readableRegion, iterateProcessMemory, openTargets,
  createWindowsTypes, createNativeApi, runScan, startWorker,
}

if (require.main === module && typeof process.send === 'function') startWorker()
