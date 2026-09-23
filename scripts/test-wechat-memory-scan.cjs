// Pure synthetic buffers and mocked Mach functions. No process inspection,
// administrator prompt, database, native library, or real WeChat data is used.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { spawnSync } = require('node:child_process')
const ts = require('typescript')

const filename = path.join(__dirname, '../electron/services/wechatMemoryScan.ts')
const moduleObject = { exports: {} }
vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { module: moduleObject, exports: moduleObject.exports, Buffer }, { filename })
const { WECHAT_HEX_SCAN_PY, collectWechatHexCandidates, WechatHexCandidateStream } = moduleObject.exports
const key = 'a1'.repeat(32)
const salt = 'b2'.repeat(16)
const other = 'c3'.repeat(32)
const ascii = value => Buffer.from(value, 'ascii')
const wide = value => Buffer.from(value, 'utf16le')
const fixtures = [
  [ascii(`!${key}!`), [key]],
  [ascii(`!${key.toUpperCase()}!`), [key]],
  [ascii(`!${'7'.repeat(64)}!`), ['7'.repeat(64)]],
  [ascii(`x'${key}'`), [key]],
  [ascii(`x'${key}${salt}'`), [key]],
  [ascii(`"X'${key.toUpperCase()}${salt}'"`), [key]],
  [ascii(key + salt), []],
  [ascii('a' + key), []],
  [ascii(key.slice(1)), []],
  [ascii(key + key), []],
  [ascii(`x'${key}${salt}a'`), []],
  [ascii(`ax'${key}${salt}'`), []],
  [ascii(`x'${key}${salt}`), []],
  [wide(`!${key}!`), [key]],
  [wide(`x'${key}${salt}'`), [key]],
  [Buffer.concat([Buffer.from([255]), wide(`!x'${key}${salt}'!`)]), [key]],
  [wide(key + salt), []],
  [wide('a' + key), []],
  [wide(`ax'${key}${salt}'`), []],
  [Buffer.from(key, 'hex'), []],
  [ascii(`!${key}!${other}!${key}!`), [key, other]],
]
// Preserve the old matcher's accepted language while moving left-boundary
// checks after the fast search. Long runs must never yield a 64-byte suffix.
function referenceCandidates(data) {
  const text = data.toString('latin1')
  const counts = new Map()
  for (const [expression, wide] of [
    [/(?<![0-9a-f])([0-9a-f]{64})(?![0-9a-f])/gi, false],
    [/(?<![a-z0-9_])x'([0-9a-f]{96})'/gi, false],
    [/(?<![0-9a-f]\x00)((?:[0-9a-f]\x00){64})(?![0-9a-f]\x00)/gi, true],
    [/(?<![a-z0-9_]\x00)x\x00'\x00((?:[0-9a-f]\x00){96})'\x00/gi, true],
  ]) {
    for (const match of text.matchAll(expression)) {
      const value = (wide ? match[1].replace(/\x00/g, '') : match[1]).slice(0, 64).toLowerCase()
      counts.set(value, (counts.get(value) || 0) + 1)
    }
  }
  return counts
}
for (const length of [0, 1, 63, 64, 65, 66, 95, 96, 97, 128, 129, 130, 512, 4096]) {
  const run = 'a1'.repeat(Math.ceil(length / 2)).slice(0, length)
  for (const text of [run, `!${run}!`, `x'${run}'`, `ax'${run}'`, `_${run}a`]) {
    for (const encode of [ascii, wide]) {
      const data = encode(text)
      const expected = referenceCandidates(data)
      const actual = new Map()
      collectWechatHexCandidates(data, actual)
      assert.deepEqual([...actual.entries()].sort(), [...expected.entries()].sort())
      fixtures.push([data, [...expected.keys()]])
    }
  }
}
for (const [data, expected] of fixtures) {
  const counts = new Map()
  collectWechatHexCandidates(data, counts)
  assert.deepEqual([...counts.keys()].sort(), [...expected].sort())
}
const repeated = new Map()
collectWechatHexCandidates(ascii(`!${key}!${key}!`), repeated)
assert.equal(repeated.get(key), 2)
const streamFixtures = [
  [ascii(`!${key}!`), [key]],
  [ascii(`x'${key}${salt}'`), [key]],
  [wide(`x'${key}${salt}'`), [key]],
  [ascii(key + salt), []],
  [wide(key + salt), []],
  [ascii('!'.repeat(300) + key + salt + '!'.repeat(300)), []],
  [ascii('a'.repeat(1024)), []],
]
for (const [data, expected] of streamFixtures) {
  for (const width of [1, 2, 3, 31, 63, 64, 65, 127, 128, 197, 256, 512]) {
    const counts = new Map()
    const stream = new WechatHexCandidateStream(counts)
    for (let offset = 0; offset < data.length; offset += width) stream.feed(data.subarray(offset, offset + width))
    stream.feed(Buffer.alloc(0), true)
    assert.deepEqual([...counts.keys()].sort(), [...expected].sort())
    assert.ok([...counts.values()].every(count => count === 1), 'TS overlap must not inflate candidate ranking')
  }
}

const harness = String.raw`
import contextlib, ctypes, io, json, os, pathlib, stat, sys, tempfile
payload = json.load(sys.stdin)
def forbidden_native(*args, **kwargs):
    raise AssertionError('Native libraries are forbidden in this test')
ctypes.CDLL = forbidden_native
namespace = {'__name__': 'isolated_scan_test'}
exec(payload['script'], namespace)
for fixture in payload['fixtures']:
    counts = {}
    data = bytes.fromhex(fixture['hex'])
    namespace['collect'](data, counts)
    assert sorted(counts) == sorted(fixture['expected'])

key = payload['key']
raw96 = (key + payload['salt']).encode('ascii')
stream_cases = [
    (b'!' + key.encode() + b'!', [key]),
    (b"x'" + raw96 + b"'", [key]),
    (("x'" + raw96.decode() + "'").encode('utf-16le'), [key]),
    (raw96, []),
    (raw96.decode().encode('utf-16le'), []),
    (b'!' * 300 + raw96 + b'!' * 300, []),
    (b'a' * 1024, []),
]
for data, expected in stream_cases:
    for width in [1, 2, 3, 31, 63, 64, 65, 127, 128, 197, 256, 512]:
        counts = {}
        stream = namespace['CandidateStream'](counts)
        for offset in range(0, len(data), width):
            stream.feed(data[offset:offset + width])
        stream.feed(b'', final=True)
        assert sorted(counts) == expected, (width, len(data), len(counts))
        assert all(count == 1 for count in counts.values()), 'overlap must not inflate candidate ranking'

real_monotonic = namespace['time'].monotonic
original_write = namespace['write_progress']
original_argv = list(sys.argv)
cases = []
for scenario in ['done', 'large-timeout', 'small-first', 'cancelled', 'attach-denied', 'load-failed', 'missing-marker', 'enumeration-cancel', 'enumeration-timeout', 'enumeration-failure']:
    with tempfile.TemporaryDirectory(prefix='synthetic-wechat-scan-') as directory:
        marker = pathlib.Path(directory) / 'active'
        progress_path = pathlib.Path(directory) / 'progress.json'
        marker.write_text('')
        os.chmod(marker, 0o600)
        clock = [0.0]
        state = {'reads': 0, 'released': 0, 'enumerations': 0, 'objectPorts': [], 'releasedObjects': [], 'readAddresses': []}
        snapshots = []
        namespace['time'].monotonic = lambda: clock[0]
        namespace['CHUNK'] = 512
        def capture_progress(path, marker_path, value, owner=None):
            snapshots.append(dict(value))
            original_write(path, marker_path, value, owner)
        namespace['write_progress'] = capture_progress
        region_size = 80 * 1024 * 1024 + 4096 if scenario == 'large-timeout' else 1024
        large_size = 80 * 1024 * 1024 + 4096
        region_map = [(4096, large_size), (large_size + 8192, 512), (large_size + 12288, 1024)] if scenario == 'small-first' else [(4096, region_size)]
        class FakeMach:
            def mach_task_self(self):
                return 1
            def task_for_pid(self, caller, pid, target):
                assert pid == 12345
                target._obj.value = 0 if scenario == 'attach-denied' else 2
                return 5 if scenario == 'attach-denied' else 0
            def mach_vm_region(self, task, address, size, flavor, info, count, obj):
                state['enumerations'] += 1
                if scenario == 'enumeration-failure' and state['enumerations'] == 2:
                    return 5
                remaining = [(base, length) for base, length in region_map if base >= address._obj.value]
                if not remaining:
                    return 1
                address._obj.value, size._obj.value = remaining[0]
                ctypes.c_int.from_buffer(info, 0).value = 3
                obj._obj.value = 100 + state['enumerations']
                state['objectPorts'].append(obj._obj.value)
                if scenario == 'enumeration-cancel':
                    marker.unlink()
                if scenario == 'enumeration-timeout':
                    clock[0] += 1.1
                return 0
            def mach_vm_read_overwrite(self, task, address, size, buffer, read_size):
                state['reads'] += 1
                state['readAddresses'].append(address)
                data = (b'!' + key.encode() + b'!').ljust(size, b'!')
                ctypes.memmove(buffer, data, len(data))
                read_size._obj.value = len(data)
                clock[0] += .6 if scenario in ['large-timeout', 'small-first'] else .2
                if scenario == 'cancelled':
                    marker.unlink()
                return 0
            def mach_port_deallocate(self, caller, target):
                if target == 2:
                    state['released'] += 1
                else:
                    state['releasedObjects'].append(target)
        def fake_load():
            if scenario == 'load-failed':
                raise RuntimeError('PRIVATE_ERROR_CONTENT_MUST_NOT_ESCAPE')
            return FakeMach()
        namespace['load_mach'] = fake_load
        if scenario == 'missing-marker':
            marker.unlink()
        sys.argv = ['scan.py', '12345', str(marker), '1', str(progress_path)]
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = namespace['main']()
        assert stderr.getvalue() == ''
        output = stdout.getvalue()
        assert 'PRIVATE_ERROR' not in output
        if scenario in ['done', 'large-timeout', 'small-first']:
            assert code == 0
            assert output.strip() == key
        elif scenario == 'enumeration-timeout':
            assert code == 0
            assert output == ''
        else:
            assert code == (3 if scenario in ['cancelled', 'missing-marker', 'enumeration-cancel'] else 2)
            assert output == '', 'errors and cancellation must never emit candidates'
        if scenario == 'missing-marker':
            assert not progress_path.exists()
            assert state['reads'] == 0
            continue
        value = json.loads(progress_path.read_text())
        expected_stage = {'large-timeout': 'timeout', 'small-first': 'timeout', 'attach-denied': 'error', 'load-failed': 'error', 'enumeration-cancel': 'cancelled', 'enumeration-timeout': 'timeout', 'enumeration-failure': 'error'}.get(scenario, scenario)
        assert value['stage'] == expected_stage
        assert key not in json.dumps(snapshots), 'progress never includes keys or memory excerpts'
        assert set(value) <= {'stage', 'regions', 'scannedBytes', 'candidates', 'elapsedMs', 'errorCode'}
        assert stat.S_IMODE(progress_path.stat().st_mode) == 0o600
        assert progress_path.stat().st_uid == os.getuid()
        assert snapshots[0]['stage'] == 'authorized'
        if scenario == 'large-timeout':
            assert state['reads'] == 2, 'large regions are scanned in bounded chunks instead of skipped'
            assert value['scannedBytes'] == 1024
            assert value['candidates'] == 1
            assert value['regions'] == 1
            assert value['elapsedMs'] == 1200
            assert len([entry for entry in snapshots if entry['stage'] == 'scanning']) >= 2, 'long scans publish periodic progress'
        if scenario == 'small-first':
            assert state['enumerations'] == 4, 'all metadata is enumerated before reading any region'
            assert state['readAddresses'] == [large_size + 8192, large_size + 12288], 'later small regions must be covered before the earlier giant allocation'
            assert value['regions'] == 2
            assert value['scannedBytes'] == 1024
        if scenario.startswith('enumeration-'):
            assert state['reads'] == 0, 'enumeration cancellation, failure or shared deadline must prevent any later memory read'
        if scenario not in ['attach-denied', 'load-failed', 'missing-marker']:
            assert state['released'] == 1, 'every attached task port is released exactly once'
        assert sorted(state['releasedObjects']) == sorted(state['objectPorts']), 'all enumeration object ports are released before cancellation or scanning'
        if scenario == 'attach-denied':
            assert value['errorCode'] == 'ATTACH_DENIED'
        if scenario == 'enumeration-failure':
            assert value['errorCode'] == 'REGION_ENUMERATION_FAILED'
        assert not list(pathlib.Path(directory).glob('.scan-progress-*')), 'atomic-write temporary files are removed'
        cases.append(scenario)
namespace['time'].monotonic = real_monotonic
sys.argv = original_argv
print(json.dumps({'syntheticFixtures': len(payload['fixtures']), 'streamCases': len(stream_cases) * 12, 'lifecycleCases': len(cases) + 1}))
`
const python = spawnSync('python3', ['-c', harness], {
  input: JSON.stringify({ script: WECHAT_HEX_SCAN_PY, key, salt, fixtures: fixtures.map(([data, expected]) => ({ hex: data.toString('hex'), expected })) }),
  encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
})
assert.equal(python.status, 0, python.stderr || python.error?.message || 'Synthetic Python checks failed')
const result = JSON.parse(python.stdout)
assert.equal(result.syntheticFixtures, fixtures.length)
assert.equal(result.lifecycleCases, 10)
console.log(`WeChat memory scanner passed: ${fixtures.length} TS/Python fixtures, ${result.streamCases} chunk-boundary cases, ${result.lifecycleCases} mocked lifecycle cases; zero real process reads`)
