const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const ts = require('typescript')

// This tests WcdbCore's Windows branch with the real independent native reader
// on the current host. All encrypted DB/WAL fixtures are newly created in temp.
// No user configuration, WeChat database/process, koffi or wcdb_api is accessed.
const root = path.resolve(__dirname, '..')
const requireRuntime = process.env.NOTEWAKE_SQLCIPHER_TEST_ROOT
  ? createRequire(path.join(path.resolve(process.env.NOTEWAKE_SQLCIPHER_TEST_ROOT), 'package.json'))
  : require
const Database = requireRuntime('better-sqlite3-multiple-ciphers')
const localRequire = createRequire(path.join(root, 'package.json'))
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'notewake-windows-core-'))
fs.chmodSync(directory, 0o700)
const writers = []
const cores = []
let checks = 0
const checked = (actual, expected, message) => {
  assert.deepEqual(actual === undefined ? undefined : JSON.parse(JSON.stringify(actual)), expected, message)
  checks++
}
function loadTs(relativePath, dependencies, globals = {}) {
  const filename = path.join(root, relativePath)
  const module = { exports: {} }
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  vm.runInNewContext(code, { module, exports: module.exports, Buffer, require: dependencies, ...globals }, { filename })
  return module.exports
}
const adapterRequire = name => {
  assert.notEqual(name, 'koffi', 'independent reader must never load koffi')
  return name.startsWith('better-sqlite3-multiple-ciphers') ? requireRuntime(name) : localRequire(name)
}
adapterRequire.resolve = name => name.startsWith('better-sqlite3-multiple-ciphers')
  ? requireRuntime.resolve(name) : localRequire.resolve(name)
const adapter = loadTs('electron/services/windowsSqlcipher.ts', adapterRequire)
const logs = []
const guardedFs = new Proxy(fs, { get(target, property) {
  const value = target[property]
  if (typeof value !== 'function') return value
  return (...args) => {
    if (typeof args[0] === 'string') {
      // ResolveKindPath probes a bare message filename before its account path.
      // Model an empty cwd without touching files outside the fixture directory.
      if (property === 'existsSync' && !path.isAbsolute(args[0])) return false
      assert(!/wcdb_api|WCDB\.(?:dll|dylib)|license/i.test(args[0]), 'Windows core must not inspect bridge/library/license paths')
      assert(path.resolve(args[0]).startsWith(directory + path.sep) || path.resolve(args[0]) === directory,
        'Core filesystem access is restricted to generated fixtures')
    }
    return value(...args)
  }
} })
function makeCore() {
  const { WcdbCore } = loadTs('electron/services/wcdbCore.ts', name => {
    if (name === 'path') return path
    if (name === 'fs') return guardedFs
    if (name === './windowsSqlcipher') return adapter
    if (name === './chat/rowDecoders') return {}
    throw new Error(`Prohibited core dependency: ${name}`)
  }, {
    process: { platform: 'win32', env: {}, cwd: () => root },
    console: Object.fromEntries(['log', 'warn', 'error'].map(level => [level, (...args) => logs.push([level, ...args])])),
  })
  const core = new WcdbCore()
  core.setPaths(path.join(directory, 'prohibited-native-resources'), path.join(directory, 'no-user-config'))
  for (const method of ['getLibraryPath', 'getWindowsCoreLibraryPath', 'initializeSqliteFallback', 'hasDeniedNativeLicense']) {
    core[method] = () => { throw new Error(`Prohibited inherited bridge operation: ${method}`) }
  }
  cores.push(core)
  return core
}
function makeAccount(wxid) {
  const account = { wxid, accountRoot: path.join(directory, wxid), keyMap: {}, files: {}, writers: {}, materials: {} }
  for (const kind of ['session', 'contact', 'message']) {
    const relative = kind === 'message' ? 'message/message_0.db' : `${kind}/${kind}.db`
    const file = path.join(account.accountRoot, 'db_storage', relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const key = crypto.randomBytes(32).toString('hex')
    const salt = crypto.randomBytes(16).toString('hex')
    const db = new Database(file)
    writers.push(db)
    db.pragma("cipher='sqlcipher'")
    db.pragma('legacy=4')
    db.pragma('legacy_page_size=4096')
    db.key(Buffer.from(`raw:${key}${salt}`, 'ascii'))
    db.exec('CREATE TABLE sentinel(id INTEGER PRIMARY KEY, marker TEXT)')
    db.prepare('INSERT INTO sentinel VALUES (?, ?)').run(1, `${wxid}:${kind}:base`)
    db.pragma('journal_mode=WAL')
    db.pragma('wal_autocheckpoint=0')
    db.prepare('INSERT INTO sentinel VALUES (?, ?)').run(2, `${wxid}:${kind}:wal`)
    assert(fs.statSync(file + '-wal').size > 32, 'fixture includes a committed encrypted WAL frame')
    assert.equal(fs.readFileSync(file).subarray(0, 16).toString('hex'), salt)
    account.keyMap[salt] = key
    account.files[kind] = file
    account.writers[kind] = db
    account.materials[kind] = { key, salt }
  }
  account.sessionKey = account.materials.session.key
  assert.equal(new Set(Object.values(account.keyMap)).size, 3)
  return account
}
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function sourceState(accounts) {
  return accounts.flatMap(account => Object.values(account.files).flatMap(file => [file, file + '-wal'].map(name => [name, hash(name)])))
}
function unchanged(state, label) {
  for (const [file, digest] of state) assert.equal(hash(file), digest, label)
  checks++
}
const queryPath = kind => kind === 'message' ? 'message_0.db' : ''
async function assertAccount(core, account, suffix = '') {
  for (const kind of ['session', 'contact', 'message']) {
    checked(await core.execQuery(kind, queryPath(kind), 'SELECT id, marker FROM sentinel ORDER BY id'), {
      success: true,
      rows: [
        { id: 1, marker: `${account.wxid}:${kind}:base` },
        { id: 2, marker: `${account.wxid}:${kind}:wal` },
        ...(suffix && kind === 'message' ? [{ id: 3, marker: suffix }] : []),
      ],
    }, `${kind} opens with its own raw key and reads original DB plus WAL`)
  }
}
function activeSnapshot(core) {
  return {
    path: core.currentPath, key: core.currentKey, wxid: core.currentWxid,
    storage: core.currentDbStoragePath, keys: core.currentDatabaseKeys,
    keysJson: JSON.stringify(core.currentDatabaseKeys), handles: new Map(core.sqliteHandles),
  }
}
function assertActiveUnchanged(core, previous) {
  assert.equal(core.isConnected(), true)
  for (const [property, value] of [['currentPath', previous.path], ['currentKey', previous.key],
    ['currentWxid', previous.wxid], ['currentDbStoragePath', previous.storage], ['currentDatabaseKeys', previous.keys]]) {
    assert.equal(core[property], value, `a standalone probe must preserve ${property}`)
  }
  assert.equal(JSON.stringify(core.currentDatabaseKeys), previous.keysJson)
  assert.equal(core.sqliteHandles.size, previous.handles.size)
  for (const [file, handle] of previous.handles) assert.equal(core.sqliteHandles.get(file), handle, 'a probe must not close/replace a live handle')
  checks++
}
async function main() {
  const accountA = makeAccount('wxid_synthetic_A')
  const accountB = makeAccount('wxid_synthetic_B')
  const baseline = sourceState([accountA, accountB])
  const core = makeCore()
  checked(await core.initialize(), { success: true }, 'Windows selects the independent native reader')
  checked(core.lib, null, 'no bridge library was loaded')
  checked(core.koffi, null, 'no FFI runtime was loaded')
  checked((await core.testConnection(directory, accountA.sessionKey, accountA.wxid, accountA.keyMap)).success, true,
    'all three per-database keys authenticate via an account parent path')
  checked(core.isConnected(), false, 'a successful standalone probe does not connect the account')
  checked(core.sqliteHandles.size, 0, 'standalone probes retain no handles')
  checked((await core.testConnection(directory, accountA.sessionKey, accountA.wxid)).success, false,
    'one session raw key must not be promoted to a multi-database account key')
  const missingContact = { ...accountA.keyMap }; delete missingContact[accountA.materials.contact.salt]
  const missingSession = { ...accountA.keyMap }; delete missingSession[accountA.materials.session.salt]
  const missingMessage = { ...accountA.keyMap }; delete missingMessage[accountA.materials.message.salt]
  const wrongContact = { ...accountA.keyMap, [accountA.materials.contact.salt]: crypto.randomBytes(32).toString('hex') }
  const wrongSession = { ...accountA.keyMap, [accountA.materials.session.salt]: crypto.randomBytes(32).toString('hex') }
  const wrongSalt = { ...accountA.keyMap }; delete wrongSalt[accountA.materials.contact.salt]
  wrongSalt[crypto.randomBytes(16).toString('hex')] = accountA.materials.contact.key
  for (const [label, map] of [
    ['empty map', {}], ['missing session salt', missingSession], ['missing contact salt', missingContact],
    ['missing message salt', missingMessage], ['wrong session key', wrongSession],
    ['wrong contact key', wrongContact], ['wrong salt mapping', wrongSalt],
  ]) {
    checked((await core.testConnection(directory, accountA.sessionKey, accountA.wxid, map)).success, false, label)
    checked(core.sqliteHandles.size, 0, `${label}: failed probe leaks no handle`)
  }
  unchanged(baseline, 'successful/failed connection probes do not modify original DB or WAL')
  checked(await core.open(directory, accountA.sessionKey, accountA.wxid, accountA.keyMap), true,
    'open account A with the verified per-database key map')
  await assertAccount(core, accountA)
  const active = activeSnapshot(core)
  checked(core.sqliteHandles.size, 3, 'session/contact/message are distinct cached reader handles')
  const incompleteB = { ...accountB.keyMap }; delete incompleteB[accountB.materials.contact.salt]
  for (const [label, map, expected] of [
    ['B wrong-account map', accountA.keyMap, false],
    ['B missing contact key', incompleteB, false],
    ['B verified map', accountB.keyMap, true],
  ]) {
    checked((await core.testConnection(directory, accountB.sessionKey, accountB.wxid, map)).success, expected, label)
    assertActiveUnchanged(core, active)
    await assertAccount(core, accountA)
  }
  checked((await core.testConnection(directory, accountA.sessionKey, accountA.wxid, wrongContact)).success, false,
    'changing keyMap cannot reuse an already-connected success result')
  assertActiveUnchanged(core, active)
  checked((await core.testConnection(directory, accountA.sessionKey, accountA.wxid, missingContact)).success, false,
    'a missing keyMap entry cannot reuse an already-connected success result')
  assertActiveUnchanged(core, active)
  checked((await core.execQuery('session', '', 'DELETE FROM sentinel')).success, false, 'read-only behavior survives the core integration')
  unchanged(baseline, 'queries, rejected writes and B probes do not modify original DB/WAL')

  accountA.writers.message.prepare('INSERT INTO sentinel VALUES (?, ?)').run(3, 'later-committed-message')
  const afterCommit = sourceState([accountA, accountB])
  assert.notEqual(hash(accountA.files.message + '-wal'), baseline.find(([file]) => file === accountA.files.message + '-wal')[1])
  await assertAccount(core, accountA, 'later-committed-message')
  assertActiveUnchanged(core, active)
  unchanged(afterCommit, 'reading a newer WAL transaction does not modify original DB/WAL')
  core.close()
  checked(core.isConnected(), false, 'close disconnects the account')
  checked(core.sqliteHandles.size, 0, 'close releases every independent reader handle')
  checked(core.currentDatabaseKeys, undefined, 'close clears the active per-database map')
  for (const secret of [...Object.keys(accountA.keyMap), ...Object.values(accountA.keyMap), ...Object.keys(accountB.keyMap), ...Object.values(accountB.keyMap)]) {
    assert(!JSON.stringify(logs).includes(secret), 'core logs must not contain raw keys or salts')
  }
  console.log(`PASS: ${checks} Windows WcdbCore independent-reader, per-database key, account isolation, original DB/WAL and live WAL checks (${process.platform}-${process.arch}; simulated win32 core).`)
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => {
  for (const core of cores) { try { core.close() } catch {} }
  for (const db of writers.reverse()) { try { db.close() } catch {} }
  fs.rmSync(directory, { recursive: true, force: true })
})
