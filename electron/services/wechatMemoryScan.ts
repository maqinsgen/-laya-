// SQLCipher's explicit-salt literal is x'<64 hex key><32 hex salt>'.
// https://www.zetetic.net/sqlcipher/sqlcipher-api/#PRAGMA_key
// These are candidates only; database validation must establish the actual key.
const candidatePatterns = [
  { expression: /([0-9a-f]{64,65})/gi, wide: false, literal: false },
  { expression: /x'([0-9a-f]{96})'/gi, wide: false, literal: true },
  { expression: /((?:[0-9a-f]\x00){64,65})/gi, wide: true, literal: false },
  { expression: /x\x00'\x00((?:[0-9a-f]\x00){96})'\x00/gi, wide: true, literal: true },
]

function collectWithin(data: Buffer, counts: Map<string, number>, minStart = 0, maxStart = data.length): void {
  const text = data.toString('latin1')
  for (const { expression, wide, literal } of candidatePatterns) {
    expression.lastIndex = 0
    for (let match = expression.exec(text); match; match = expression.exec(text)) {
      if (match.index < minStart || match.index >= maxStart) continue
      // A 65-character run proves this is not a standalone key. Bounding the
      // repetition also prevents huge UTF-16 hex runs growing the regex stack.
      if (!literal && match[1].length !== (wide ? 128 : 64)) continue
      const boundary = literal ? /[a-z0-9_]/i : /[0-9a-f]/i
      if (wide ? match.index >= 2 && text[match.index - 1] === '\x00' && boundary.test(text[match.index - 2])
        : match.index > 0 && boundary.test(text[match.index - 1])) continue
      const key = (wide ? match[1].replace(/\x00/g, '') : match[1]).slice(0, 64).toLowerCase()
      counts.set(key, (counts.get(key) || 0) + 1)
    }
  }
}

/** Inspect a synthetic or already-read byte buffer; never opens a process. */
export function collectWechatHexCandidates(data: Buffer, counts: Map<string, number>): void {
  collectWithin(data, counts)
}

/** Discard this instance at a read gap; finish each complete region with final=true. */
export class WechatHexCandidateStream {
  private tail = Buffer.alloc(0)
  private context = 0

  constructor(private readonly counts: Map<string, number>) {}

  feed(data: Buffer, final = false): void {
    const block = this.tail.length ? Buffer.concat([this.tail, data]) : data
    const cutoff = final ? block.length : Math.max(0, block.length - 256)
    collectWithin(block, this.counts, this.context, cutoff)
    const keep = Math.max(0, cutoff - 2)
    this.tail = final ? Buffer.alloc(0) : Buffer.from(block.subarray(keep))
    this.context = final ? 0 : cutoff - keep
  }
}

/** CLI: pid marker timeoutSeconds progressPath. stdout contains keys only. */
export const WECHAT_HEX_SCAN_PY = String.raw`import ctypes, json, os, re, sys, tempfile, time
from ctypes import c_int, c_uint32, c_uint64, c_void_p, POINTER, byref

CHUNK = 4 * 1024 * 1024
OVERLAP = 256
PATTERNS = [
    (re.compile(rb'([0-9a-fA-F]{64,65})'), False, False),
    (re.compile(rb"[xX]'([0-9a-fA-F]{96})'"), False, True),
    (re.compile(rb'((?:[0-9a-fA-F]\x00){64,65})'), True, False),
    (re.compile(rb"[xX]\x00'\x00((?:[0-9a-fA-F]\x00){96})'\x00"), True, True),
]
HEX_BYTES = b'0123456789abcdefABCDEF'
WORD_BYTES = b'0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_'

def collect(data, counts, min_start=0, max_start=None):
    if max_start is None:
        max_start = len(data)
    for expression, wide, literal in PATTERNS:
        for match in expression.finditer(data):
            if not min_start <= match.start() < max_start:
                continue
            if not literal and match.end(1) - match.start(1) != (128 if wide else 64):
                continue
            preceding = WORD_BYTES if literal else HEX_BYTES
            start = match.start()
            if wide:
                if start >= 2 and data[start - 1] == 0 and data[start - 2] in preceding:
                    continue
            elif start > 0 and data[start - 1] in preceding:
                continue
            raw = match.group(1)
            key = (raw[::2] if wide else raw)[:64].decode('ascii').lower()
            counts[key] = counts.get(key, 0) + 1

class CandidateStream:
    # Keep enough bytes for a complete wide SQLCipher literal, plus its boundary.
    # Delaying the tail prevents a 96-hex run split at byte 64 becoming a false key.
    def __init__(self, counts):
        self.counts = counts
        self.tail = b''
        self.context = 0

    def feed(self, data, final=False):
        block = self.tail + data
        cutoff = len(block) if final else max(0, len(block) - OVERLAP)
        collect(block, self.counts, self.context, cutoff)
        keep = max(0, cutoff - 2)
        self.tail = b'' if final else block[keep:]
        self.context = 0 if final else cutoff - keep

def write_progress(path, marker, value, owner=None):
    # Elevated replacement must remain readable only by the invoking app user.
    owner = owner or os.stat(marker)
    descriptor, temporary = tempfile.mkstemp(prefix='.scan-progress-', dir=os.path.dirname(path) or '.')
    try:
        os.fchmod(descriptor, 0o600)
        if hasattr(os, 'fchown'):
            try:
                os.fchown(descriptor, owner.st_uid, owner.st_gid)
            except PermissionError:
                if os.fstat(descriptor).st_uid != owner.st_uid:
                    raise
        with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
            descriptor = -1
            json.dump(value, output, separators=(',', ':'))
        os.replace(temporary, path)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass

def load_mach():
    # Kept out of module import so isolated tests never load a native library.
    lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
    lib.mach_task_self.restype = c_uint32
    lib.task_for_pid.argtypes = [c_uint32, c_int, POINTER(c_uint32)]
    lib.mach_vm_region.argtypes = [c_uint32, POINTER(c_uint64), POINTER(c_uint64), c_int, c_void_p, POINTER(c_uint32), POINTER(c_uint32)]
    lib.mach_vm_read_overwrite.argtypes = [c_uint32, c_uint64, c_uint64, c_void_p, POINTER(c_uint64)]
    lib.mach_port_deallocate.argtypes = [c_uint32, c_uint32]
    return lib

def main():
    pid, marker, seconds, progress_path = sys.argv[1:5]
    pid, seconds = int(pid), float(seconds)
    if pid <= 0 or not 0 < seconds <= 3600:
        return 2
    started = time.monotonic()
    deadline = started + seconds
    counts = {}
    regions = 0
    scanned_bytes = 0
    last_progress = -float('inf')
    marker_owner = None

    def progress(stage, force=False, error=None):
        nonlocal last_progress
        current = time.monotonic()
        if not force and current - last_progress < 1:
            return
        value = dict(stage=stage, regions=regions, scannedBytes=scanned_bytes,
                     candidates=len(counts), elapsedMs=max(0, int((current - started) * 1000)))
        if error:
            value['errorCode'] = error
        write_progress(progress_path, marker, value, marker_owner)
        last_progress = current

    def stopped():
        if not os.path.exists(marker):
            return 'cancelled'
        if time.monotonic() >= deadline:
            return 'timeout'
        return None

    lib = None
    task = c_uint32(0)
    self_task = 0
    stage = 'done'
    try:
        if not os.path.exists(marker):
            return 3
        marker_owner = os.stat(marker)
        progress('authorized', True)
        lib = load_mach()
        progress('attaching', True)
        self_task = lib.mach_task_self()
        attach = lib.task_for_pid(self_task, pid, byref(task))
        if attach != 0 or not task.value:
            progress('error', True, 'ATTACH_DENIED')
            return 2
        progress('scanning', True)
        address = 0
        info = (ctypes.c_byte * 64)()
        writable_regions = []
        # Enumerate metadata first. Address order can otherwise spend the whole
        # deadline in one giant allocation before reaching later account data.
        while address < 0x7FFFFFFFFFFF:
            stage = stopped() or 'done'
            if stage != 'done':
                break
            addr, size, count, obj = c_uint64(address), c_uint64(0), c_uint32(9), c_uint32(0)
            result = lib.mach_vm_region(task.value, byref(addr), byref(size), 9, info, byref(count), byref(obj))
            if obj.value:
                lib.mach_port_deallocate(self_task, obj.value)
            if result != 0:
                if result != 1:  # KERN_INVALID_ADDRESS marks the end of the map.
                    progress('error', True, 'REGION_ENUMERATION_FAILED')
                    return 2
                break
            base, region = addr.value, size.value
            protection = c_int.from_buffer(info, 0).value
            if (protection & 1) and (protection & 2) and region > 0:
                writable_regions.append((base, region))
            following = base + region
            if following <= address:
                progress('error', True, 'REGION_ENUMERATION_FAILED')
                return 2
            address = following
            progress('scanning')
        if stage == 'done':
            for base, region in sorted(writable_regions, key=lambda entry: (entry[1], entry[0])):
                stage = stopped() or 'done'
                if stage != 'done':
                    break
                regions += 1
                offset = 0
                stream = CandidateStream(counts)
                while offset < region:
                    stage = stopped() or 'done'
                    if stage != 'done':
                        break
                    chunk = min(CHUNK, region - offset)
                    buffer = (ctypes.c_byte * chunk)()
                    read_size = c_uint64(0)
                    read_result = lib.mach_vm_read_overwrite(task.value, base + offset, chunk, buffer, byref(read_size))
                    offset += chunk
                    if read_result != 0 or read_size.value <= 0 or read_size.value > chunk:
                        stream = CandidateStream(counts)  # Never join across an unreadable gap.
                        progress('scanning')
                        continue
                    scanned_bytes += read_size.value
                    stream.feed(bytes(buffer)[:read_size.value], final=offset >= region and read_size.value == chunk)
                    if read_size.value < chunk:
                        stream = CandidateStream(counts)
                    progress('scanning')
                if stage != 'done':
                    break
        # Cancellation must not emit candidate keys, including after the last read.
        stage = stopped() or stage
        if stage == 'cancelled':
            progress('cancelled', True)
            return 3
        progress(stage, True)
        for key, _ in sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:80]:
            print(key)
        return 0  # A timed-out scan can still supply candidates for DB validation.
    except FileNotFoundError:
        if not os.path.exists(marker):
            return 3
        try:
            progress('error', True, 'SCAN_COMPONENT_FAILED')
        except Exception:
            pass
        return 2
    except Exception:
        try:
            progress('error', True, 'SCAN_COMPONENT_FAILED')
        except Exception:
            pass
        return 2
    finally:
        if lib is not None and task.value:
            try:
                lib.mach_port_deallocate(self_task, task.value)
            except Exception:
                pass

if __name__ == '__main__':
    sys.exit(main())
`
