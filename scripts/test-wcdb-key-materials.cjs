const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

// Real SQLCipher database tests, exclusively with generated data in a new temp
// directory. No Electron, licensing service, user configuration or WeChat data.
const root = path.resolve(__dirname, '..')
const libraryPath = path.join(root, 'resources/macos/libWCDB.dylib')
if (process.platform !== 'darwin' || !fs.existsSync(libraryPath)) {
  console.log('SKIP: native key-material regression requires the bundled macOS libWCDB.dylib')
  process.exit(0)
}

const koffi = require('koffi')
const lib = koffi.load(libraryPath)
const open = lib.func('int sqlite3_open_v2(const char *filename, _Out_ void **db, int flags, const char *vfs)')
const close = lib.func('int sqlite3_close_v2(void *db)')
const keyDatabase = lib.func('int sqlite3_key(void *db, const void *key, int length)')
const exec = lib.func('int sqlite3_exec(void *db, const char *sql, void *cb, void *arg, void *error)')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'notewake-sqlcipher-test-'))
fs.chmodSync(directory, 0o700)
const syntheticHex = crypto.randomBytes(32).toString('hex')
const syntheticSalt = crypto.randomBytes(16).toString('hex')
const materials = {
  binary32: Buffer.from(syntheticHex, 'hex'),
  ascii64: Buffer.from(syntheticHex, 'ascii'),
  rawLiteral: Buffer.from(`x'${syntheticHex}'`, 'ascii'),
  rawWithSalt: Buffer.from(`x'${syntheticHex}${syntheticSalt}'`, 'ascii'),
}

function databaseHandle(filename, flags, material, pageSize) {
  const output = [null]
  const rc = open(filename, output, flags, null)
  if (rc !== 0 || !output[0]) {
    if (output[0]) close(output[0])
    throw new Error('Could not open synthetic SQLCipher fixture')
  }
  try {
    assert.equal(keyDatabase(output[0], material, material.length), 0)
    assert.equal(exec(output[0], `PRAGMA cipher_page_size=${pageSize}`, null, null, null), 0)
    return output[0]
  } catch (error) { close(output[0]); throw error }
}

function makeFixture(name, material, pageSize = 4096) {
  const accountRoot = path.join(directory, name)
  const filename = path.join(accountRoot, 'db_storage/session/session.db')
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  const db = databaseHandle(filename, 6, material, pageSize)
  try {
    const sql = `CREATE TABLE sentinel(marker TEXT); INSERT INTO sentinel VALUES ('${name}');`
    assert.equal(exec(db, sql, null, null, null), 0, `${name}: create encrypted test rows`)
  } finally { assert.equal(close(db), 0) }
  const before = fs.readFileSync(filename)
  assert.equal(before.subarray(0, 16).equals(Buffer.from('SQLite format 3\0')), false, 'the fixture must actually be encrypted')
  return { name, accountRoot, filename, pageSize, hash: crypto.createHash('sha256').update(before).digest('hex') }
}

function readsWith(fixture, material) {
  const db = databaseHandle(fixture.filename, 1, material, fixture.pageSize)
  try { return exec(db, 'SELECT marker FROM sentinel', null, null, null) === 0 }
  finally { assert.equal(close(db), 0) }
}

function loadCore() {
  const filename = path.join(root, 'electron/services/wcdbCore.ts')
  const module = { exports: {} }
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  vm.runInNewContext(code, {
    module, exports: module.exports, Buffer,
    // Isolate process.env so the library search setup cannot alter the host.
    process: { platform: 'darwin', env: {}, cwd: () => root },
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (name === 'path') return path
      if (name === 'fs') return fs
      if (name === 'koffi') return koffi
      if (name === './chat/rowDecoders') return {}
      throw new Error(`Unexpected core dependency: ${name}`)
    },
  }, { filename })
  const core = new module.exports.WcdbCore()
  core.setPaths(path.join(root, 'resources'), directory)
  // Select only the local SQLCipher backend; never inspect a license or invoke
  // the bridge's account opening/authentication code.
  core.initialize = async () => core.initialized ? { success: true } : core.initializeSqliteFallback()
  core.hasDeniedNativeLicense = () => { throw new Error('Reading a user license is prohibited') }
  return core
}

async function assertMarker(core, expected) {
  const result = await core.execQuery('session', '', 'SELECT marker FROM sentinel')
  assert.equal(result.success, true, 'the original live connection must remain queryable')
  assert.equal(result.rows[0].marker, expected)
}

async function main() {
  const fixtures = Object.entries(materials).map(([name, material]) => makeFixture(name, material))
  const smallPage = makeFixture('rawPage1024', materials.rawLiteral, 1024)
  fixtures.push(smallPage)
  const core = loadCore()
  try {
    assert.equal((await core.initialize()).success, true)
    // The same 32 bytes mean three different keys to SQLCipher. This matrix
    // proves why adding the raw literal must not replace either legacy mode.
    for (const fixture of fixtures.slice(0, 3)) {
      for (const mode of ['binary32', 'ascii64', 'rawLiteral']) {
        assert.equal(readsWith(fixture, materials[mode]), fixture.name === mode, `${fixture.name}/${mode}: passphrase and raw-key semantics must stay distinct`)
      }
    }
    assert.equal(readsWith(fixtures[3], materials.rawLiteral), true, 'a raw key without explicit salt reads the salt from the encrypted file header')

    for (const fixture of fixtures) {
      assert.equal(core.sqliteOpenEncrypted(fixture.filename, syntheticHex, false).ok, true, `${fixture.name}: file-level format support`)
      const result = await core.testConnection(fixture.accountRoot, syntheticHex, 'synthetic-account')
      assert.equal(result.success, ['binary32', 'ascii64'].includes(fixture.name), `${fixture.name}: a single-file derived key must not become an account credential`)
      assert.equal(core.isConnected(), false, 'a successful standalone probe must not connect the account')
      assert.equal(core.sqliteHandles.size, 0, 'successful standalone probes must not retain handles')
    }

    function addCoreDatabase(fixture, relative, material) {
      const filename = path.join(fixture.accountRoot, 'db_storage', relative)
      fs.mkdirSync(path.dirname(filename), { recursive: true })
      const db = databaseHandle(filename, 6, material, 4096)
      try { assert.equal(exec(db, 'CREATE TABLE sentinel(marker TEXT)', null, null, null), 0) }
      finally { close(db) }
      return filename
    }
    const sameRaw = fixtures[2]
    const contact = addCoreDatabase(sameRaw, 'contact/contact.db', materials.rawLiteral)
    const message = addCoreDatabase(sameRaw, 'message/message_0.db', materials.rawLiteral)
    assert.equal(new Set([sameRaw.filename, contact, message].map(file => fs.readFileSync(file).subarray(0, 16).toString('hex'))).size, 3)
    assert.equal((await core.testConnection(sameRaw.accountRoot, syntheticHex, 'synthetic-account')).success, true, 'an actual shared raw key must open session, contacts and messages despite different file salts')
    const partialRaw = fixtures[3]
    addCoreDatabase(partialRaw, 'contact/contact.db', Buffer.from(`x'${crypto.randomBytes(32).toString('hex')}'`, 'ascii'))
    addCoreDatabase(partialRaw, 'message/message_0.db', materials.rawLiteral)
    assert.equal((await core.testConnection(partialRaw.accountRoot, syntheticHex, 'synthetic-account')).success, false, 'a session-only raw key must not replace the account key when contacts reject it')

    const live = fixtures[2]
    assert.equal(await core.open(live.accountRoot, syntheticHex, 'synthetic-account'), true)
    await assertMarker(core, live.name)
    const liveHandle = core.sqliteHandles.get(live.filename)
    const nativeClose = core.sqliteClose
    const closed = []
    core.sqliteClose = db => { closed.push(db); return nativeClose(db) }

    const wrongKey = crypto.randomBytes(32).toString('hex')
    const rejected = await core.testConnection(live.accountRoot, wrongKey, 'synthetic-account')
    assert.equal(rejected.success, false, 'a wrong candidate must fail a real schema read')
    assert.equal(core.isConnected(), true)
    assert.equal(core.sqliteHandles.get(live.filename), liveHandle, 'a failed probe must not evict the live handle')
    assert.equal(closed.includes(liveHandle), false, 'a failed probe must not close the live handle')
    await assertMarker(core, live.name)

    const acceptedOther = await core.testConnection(fixtures[0].accountRoot, syntheticHex, 'synthetic-account')
    assert.equal(acceptedOther.success, true)
    assert.equal(core.currentPath, live.accountRoot, 'a successful probe must not switch the active account')
    assert.equal(core.sqliteHandles.size, 1)
    assert.equal(core.sqliteHandles.get(live.filename), liveHandle)
    assert.equal(closed.includes(liveHandle), false, 'a successful probe must only close its own handles')
    await assertMarker(core, live.name)

    for (const fixture of fixtures) {
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(fixture.filename)).digest('hex'), fixture.hash, 'validation must not modify database contents')
    }
  } finally { core.close() }
  console.log('Real SQLCipher formats, salt/page-size, multi-database account validation, wrong-key rejection and connection isolation passed (synthetic databases only)')
}

main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => fs.rmSync(directory, { recursive: true, force: true }))
