const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const ts = require('typescript')

// Only newly generated temporary fixtures. No user DB, configuration, process
// scanning, wcdb_api library or license service is used by this test.
const root = path.resolve(__dirname, '..')
const requireRuntime = process.env.NOTEWAKE_SQLCIPHER_TEST_ROOT
  ? createRequire(path.join(path.resolve(process.env.NOTEWAKE_SQLCIPHER_TEST_ROOT), 'package.json'))
  : require
const Database = requireRuntime('better-sqlite3-multiple-ciphers')
const localRequire = createRequire(path.join(root, 'package.json'))
const adapterRequire = name => name.startsWith('better-sqlite3-multiple-ciphers') ? requireRuntime(name) : localRequire(name)
adapterRequire.resolve = name => name.startsWith('better-sqlite3-multiple-ciphers') ? requireRuntime.resolve(name) : localRequire.resolve(name)
const moduleObject = { exports: {} }
const filename = path.join(root, 'electron/services/windowsSqlcipher.ts')
const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText
vm.runInNewContext(code, { module: moduleObject, exports: moduleObject.exports, Buffer, require: adapterRequire }, { filename })
const { WindowsSqlcipherReader } = moduleObject.exports
const reader = new WindowsSqlcipherReader()
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'notewake-independent-sqlcipher-'))
fs.chmodSync(directory, 0o700)
const handles = []
let checks = 0
const check = (actual, expected, label) => { assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, label); checks++ }
const syntheticKey = crypto.randomBytes(32).toString('hex')
const syntheticSalt = crypto.randomBytes(16).toString('hex')
const raw = { kind: 'raw', keyHex: syntheticKey, saltHex: syntheticSalt }
const fileHash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

function writer(file, material) {
  const db = new Database(file)
  handles.push(db)
  db.pragma("cipher='sqlcipher'")
  db.pragma('legacy=4')
  db.pragma('legacy_page_size=4096')
  db.key(material.kind === 'raw'
    ? Buffer.from(`raw:${material.keyHex}${material.saltHex}`, 'ascii')
    : Buffer.from(material.value))
  return db
}
function open(file, material) {
  const db = reader.open(file, material)
  handles.push(db)
  return db
}
function rejectsOpen(file, material, label) {
  assert.throws(() => reader.open(file, material), error => {
    assert(!String(error.message).includes(syntheticKey), 'errors must omit key material')
    assert(!String(error.message).includes(file), 'errors must omit source paths')
    return /SQLCipher/.test(error.message)
  }, label)
  checks++
}
try {
  check(WindowsSqlcipherReader.checkRuntime(), { ok: true }, 'native addon loads without opening a DB')
  const file = path.join(directory, 'raw-with-wal.db')
  const source = writer(file, raw)
  source.exec('CREATE TABLE sentinel (id INTEGER, marker TEXT, payload BLOB); INSERT INTO sentinel VALUES (1, \'base\', X\'0001ff\');')
  source.pragma('journal_mode=WAL')
  source.pragma('wal_autocheckpoint=0')
  source.exec("INSERT INTO sentinel VALUES (2, 'wal-only', X'')")
  assert(fs.existsSync(file + '-wal') && fs.statSync(file + '-wal').size > 32)
  check(fs.readFileSync(file).subarray(0, 16).toString('hex'), syntheticSalt, 'fixture has the expected salt')
  const beforeDb = fileHash(file)
  const beforeWal = fileHash(file + '-wal')
  const connection = open(file, raw)
  check(reader.query(connection, 'SELECT * FROM sentinel ORDER BY id'), { ok: true, rows: [
    { id: 1, marker: 'base', payload: '0001ff' }, { id: 2, marker: 'wal-only', payload: '' },
  ] }, 'read committed encrypted WAL and BLOBs from the original DB')
  check(reader.query(connection, 'SELECT marker FROM sentinel WHERE id = ?', [2]), { ok: true, rows: [{ marker: 'wal-only' }] }, 'parameters are bound without interpolation')
  check(reader.query(connection, 'PRAGMA table_info(sentinel)').ok, true, 'schema introspection works')
  check(reader.query(connection, '-- comment\n /* c */ WITH rows AS (SELECT marker FROM sentinel) SELECT count(*) AS count FROM rows'), { ok: true, rows: [{ count: 2 }] }, 'comments and common table expressions work')
  for (const sql of [
    'DELETE FROM sentinel', 'CREATE TABLE forbidden (id INTEGER)', 'PRAGMA query_only = OFF',
    "PRAGMA rekey='unsafe'", `ATTACH DATABASE '${path.join(directory, 'forbidden.db')}' AS other`,
    "SELECT 1; DELETE FROM sentinel", 'WITH data AS (SELECT 1) DELETE FROM sentinel',
  ]) check(reader.query(connection, sql).ok, false, 'write/control statement is rejected')
  check(fileHash(file), beforeDb, 'source DB bytes unchanged after reads/rejected writes')
  check(fileHash(file + '-wal'), beforeWal, 'source WAL bytes unchanged after reads/rejected writes')
  source.exec("INSERT INTO sentinel VALUES (3, 'new-commit', NULL)")
  check(reader.query(connection, 'SELECT marker FROM sentinel WHERE id=3'), { ok: true, rows: [{ marker: 'new-commit' }] }, 'same reader sees a later committed WAL transaction')
  rejectsOpen(file, { ...raw, keyHex: crypto.randomBytes(32).toString('hex') }, 'wrong raw key rejected by authenticated schema read')
  rejectsOpen(file, { ...raw, saltHex: crypto.randomBytes(16).toString('hex') }, 'wrong raw salt rejected')
  rejectsOpen(file, { ...raw, keyHex: 'invalid' }, 'malformed raw key rejected')
  rejectsOpen(path.join(directory, 'missing.db'), raw, 'missing DB is not created')
  assert(!fs.existsSync(path.join(directory, 'missing.db')))
  const emptyFile = path.join(directory, 'empty.db')
  fs.writeFileSync(emptyFile, '')
  rejectsOpen(emptyFile, { kind: 'passphrase', value: syntheticKey }, 'empty DB does not authenticate any key')
  const plaintextFile = path.join(directory, 'plaintext.db')
  const plaintext = new Database(plaintextFile)
  plaintext.exec('CREATE TABLE sentinel(marker TEXT)')
  plaintext.close()
  rejectsOpen(plaintextFile, { kind: 'passphrase', value: syntheticKey }, 'plaintext DB is not accepted as a verified encrypted DB')
  reader.close(connection)
  reader.close(connection)
  check(reader.query(connection, 'SELECT 1').ok, false, 'closed handle fails safely')

  for (const [name, value] of [['binary-passphrase', Buffer.from(syntheticKey, 'hex')], ['ascii-passphrase', syntheticKey]]) {
    const passphrase = { kind: 'passphrase', value }
    const passFile = path.join(directory, `${name}.db`)
    const passWriter = writer(passFile, passphrase)
    passWriter.exec("CREATE TABLE sentinel(marker TEXT); INSERT INTO sentinel VALUES ('passphrase-ok')")
    passWriter.close()
    const passReader = open(passFile, passphrase)
    check(reader.query(passReader, 'SELECT marker FROM sentinel'), { ok: true, rows: [{ marker: 'passphrase-ok' }] }, `${name} retains legacy key interpretation`)
    rejectsOpen(passFile, { ...raw, saltHex: fs.readFileSync(passFile).subarray(0, 16).toString('hex') }, `${name} is not confused with a raw key`)
    reader.close(passReader)
  }

  // Cross-implementation proof: create an SQLCipher fixture using the bundled
  // upstream SQLite/SQLCipher C API, then read it through Multiple Ciphers. This
  // optional macOS check only loads libWCDB.dylib, never libwcdb_api.dylib.
  const wcdbPath = path.join(root, 'resources/macos/libWCDB.dylib')
  if (process.platform === 'darwin' && fs.existsSync(wcdbPath)) {
    const lib = require('koffi').load(wcdbPath)
    const cOpen = lib.func('int sqlite3_open_v2(const char*, _Out_ void**, int, const char*)')
    const cClose = lib.func('int sqlite3_close_v2(void*)')
    const cKey = lib.func('int sqlite3_key(void*, const void*, int)')
    const cExec = lib.func('int sqlite3_exec(void*, const char*, void*, void*, void*)')
    const upstreamFile = path.join(directory, 'upstream-sqlcipher.db')
    const out = [null]
    assert.equal(cOpen(upstreamFile, out, 6, null), 0)
    try {
      const literal = Buffer.from(`x'${syntheticKey}${syntheticSalt}'`, 'ascii')
      assert.equal(cKey(out[0], literal, literal.length), 0)
      assert.equal(cExec(out[0], 'PRAGMA cipher_compatibility=4; PRAGMA cipher_page_size=4096;', null, null, null), 0)
      assert.equal(cExec(out[0], "CREATE TABLE sentinel(marker TEXT); INSERT INTO sentinel VALUES('upstream-base'); PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO sentinel VALUES('upstream-wal');", null, null, null), 0)
      const upstreamReader = open(upstreamFile, raw)
      check(reader.query(upstreamReader, 'SELECT marker FROM sentinel ORDER BY rowid'), { ok: true, rows: [{ marker: 'upstream-base' }, { marker: 'upstream-wal' }] }, 'independent SQLCipher-created original DB + WAL are readable')
      reader.close(upstreamReader)
    } finally { assert.equal(cClose(out[0]), 0) }
  } else {
    console.log('Optional cross-implementation macOS fixture unavailable; native Multiple Ciphers fixtures were tested.')
  }
  console.log(`PASS: ${checks} independent SQLCipher runtime/raw-key/passphrase/WAL/read-only checks (${process.platform}-${process.arch}).`)
} finally {
  for (const db of handles.reverse()) { try { db.close() } catch {} }
  fs.rmSync(directory, { recursive: true, force: true })
}
