const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

// All paths below are generated under a fresh temporary directory. No Electron,
// configuration, process access, network or real WeChat database is involved.
const root = path.resolve(__dirname, '..')
const filename = path.join(root, 'electron/services/wechatDatabaseKeys.ts')
const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText
function loadVerifier(overrides = {}) {
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module, exports: module.exports, Buffer,
    require(name) {
      if (name === 'node:fs') return { ...fs, ...overrides }
      if (name === 'node:path') return path
      if (name === 'node:crypto') return crypto
      throw new Error('Unexpected verifier dependency')
    },
  }, { filename })
  return module.exports
}
const verifier = loadVerifier()
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'notewake-dbkey-synthetic-'))
fs.chmodSync(temp, 0o700)
const keyA = '11'.repeat(32)
const keyB = '22'.repeat(32)
const saltA = 'aa'.repeat(16)
const saltB = 'bb'.repeat(16)
function page(key = keyA, salt = saltA) {
  const buffer = Buffer.alloc(4096)
  Buffer.from(salt, 'hex').copy(buffer)
  for (let index = 16; index < 4032; index++) buffer[index] = (index * 17 + 3) % 256
  const macSalt = Buffer.from(salt, 'hex').map(value => value ^ 0x3a)
  const macKey = crypto.pbkdf2Sync(Buffer.from(key, 'hex'), macSalt, 2, 32, 'sha512')
  const pageNumber = Buffer.from([1, 0, 0, 0])
  crypto.createHmac('sha512', macKey).update(buffer.subarray(16, 4032)).update(pageNumber).digest().copy(buffer, 4032)
  return buffer
}
function database(account, relative, data = page()) {
  const file = path.join(temp, account, 'db_storage', relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, data)
  return file
}
function discover(account = 'wxid_A', api = verifier) { return api.discoverWechatDatabases(path.join(temp, account), account) }
function verify(account = 'wxid_A', candidates = [{ keyHex: keyA, saltHex: saltA }]) {
  return verifier.verifyWechatKeyCandidates(discover(account), candidates)
}
function throwsCode(callback, code) {
  assert.throws(callback, error => error.code === code && !error.message.includes(temp))
}
function main() {
  const original = page()
  assert.equal(verifier.verifyWechatRawKey(keyA, saltA, original), true)
  assert.equal(verifier.verifyWechatRawKey(keyB, saltA, original), false)
  assert.equal(verifier.verifyWechatRawKey(keyA, saltB, original), false)
  assert.equal(verifier.verifyWechatRawKey(keyA.toUpperCase(), saltA.toUpperCase(), original), true)
  for (const position of [0, 15, 16, 4000, 4016, 4031, 4032, 4095]) {
    const damaged = Buffer.from(original); damaged[position] ^= 1
    assert.equal(verifier.verifyWechatRawKey(keyA, saltA, damaged), false, `tampered byte ${position}`)
  }
  for (const invalid of [Buffer.alloc(0), original.subarray(0, 4095), Buffer.concat([original, Buffer.alloc(1)]), Buffer.from('SQLite format 3\0')]) {
    assert.equal(verifier.verifyWechatRawKey(keyA, saltA, invalid), false)
  }
  for (const invalid of ['', keyA + '00', keyA.slice(2), 'zz'.repeat(32), ` ${keyA}`]) {
    assert.equal(verifier.verifyWechatRawKey(invalid, saltA, original), false)
  }
  database('wxid_A', 'session/session.db')
  database('wxid_A', 'contact/contact.db')
  database('wxid_A', 'message/message_0.db', page(keyB, saltB))
  database('wxid_A', 'message/message_0.db-wal', Buffer.from('ignored'))
  database('wxid_A', 'plain.db', Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(4080)]))
  const scoped = discover()
  assert.equal(scoped.wxid, 'wxid_A')
  assert.equal(scoped.dbStoragePath, fs.realpathSync(path.join(temp, 'wxid_A/db_storage')))
  assert.equal(scoped.databases.length, 3)
  assert.equal(scoped.plaintextCount, 1)
  assert.equal(scoped.databases[0].relativePath, path.join('session', 'session.db'))
  assert.ok(scoped.databases.every(database => database.core && Buffer.isBuffer(database.page)))
  assert.equal(verifier.resolveWechatAccount(temp).wxid, 'wxid_A')
  assert.equal(verifier.resolveWechatAccount(temp, 'wxid_A').wxid, 'wxid_A')
  assert.equal(verifier.resolveWechatAccount(path.join(temp, 'wxid_A/db_storage'), 'wxid_A').wxid, 'wxid_A')
  assert.equal(verify().success, false, 'session and contact alone cannot authenticate the message database')
  assert.equal(verify().verified, 2, 'same-salt databases each count independently')
  assert.equal(verify().coreVerified, 2)
  assert.equal(verify().missingCount, 1)
  assert.equal(verify().total, 3)
  assert.equal(verify().profile, 'sqlcipher4-sha512')
  const complete = verify('wxid_A', new Map([[saltA, [keyB, keyA]], [saltB, keyB]]))
  assert.equal(complete.success, true)
  assert.equal(complete.verified, 3)
  assert.equal(complete.coreVerified, 3)
  assert.equal(complete.coreTotal, 3)
  assert.equal(complete.keysBySalt[saltA], keyA)
  assert.equal(complete.keysBySalt[saltB], keyB)
  assert.equal(complete.primaryKey, keyA)
  assert.equal(complete.missingCount, 0)
  assert.equal(verify('wxid_A', [keyA, keyB]).success, true, 'unassociated raw candidates must also authenticate every file')
  assert.equal(verify('wxid_A', [{ keyHex: keyA, saltHex: saltB }, { keyHex: keyB, saltHex: saltA }]).verified, 0)
  assert.equal(verify('wxid_A', ['invalid', { keyHex: keyA, saltHex: '' }]).verified, 0)
  throwsCode(() => verify('wxid_A', Array(4097).fill(keyA)), 'CANDIDATE_LIMIT')

  database('wxid_B', 'session/session.db', page(keyB, saltB))
  throwsCode(() => verifier.resolveWechatAccount(temp), 'MULTIPLE_ACCOUNTS')
  assert.equal(verifier.resolveWechatAccount(temp, 'wxid_B').wxid, 'wxid_B')
  assert.equal(verifier.discoverWechatDatabases(temp, 'wxid_A').databases.length, 3)
  throwsCode(() => verifier.resolveWechatAccount(path.join(temp, 'wxid_A'), 'wxid_B'), 'ACCOUNT_MISMATCH')
  throwsCode(() => verifier.resolveWechatAccount(path.join(temp, 'wxid_A/db_storage'), 'wxid_B'), 'ACCOUNT_MISMATCH')
  throwsCode(() => verifier.resolveWechatAccount(temp, 'wxid'), 'ACCOUNT_NOT_FOUND')
  throwsCode(() => verifier.resolveWechatAccount(temp, '../wxid_A'), 'INVALID_ACCOUNT')
  throwsCode(() => verifier.resolveWechatAccount(temp, 'wxid_A/../wxid_B'), 'INVALID_ACCOUNT')
  throwsCode(() => verifier.resolveWechatAccount(temp, 'wxid_A\\other'), 'INVALID_ACCOUNT')
  throwsCode(() => verifier.resolveWechatAccount(''), 'DATABASE_PATH_REQUIRED')
  assert.equal(verifier.verifyWechatKeyCandidates(discover('wxid_B'), [{ keyHex: keyA, saltHex: saltA }]).success, false)

  database('short', 'session.db')
  database('short', 'contact.db', original.subarray(0, 100))
  database('short', 'message_0.db', Buffer.alloc(0))
  const short = verify('short')
  assert.equal(short.success, false)
  assert.equal(short.coreTotal, 3)
  assert.equal(short.coreVerified, 1)
  assert.equal(short.missingCount, 2)
  database('optional', 'session.db')
  database('optional', 'unrelated.db', page(keyB, saltB))
  assert.equal(verify('optional').success, true)
  assert.equal(verify('optional').missingCount, 1)
  database('noncore', 'unrelated.db')
  assert.equal(verify('noncore').success, false)
  fs.mkdirSync(path.join(temp, 'empty/db_storage'), { recursive: true })
  assert.equal(verify('empty').success, false)
  database('collision', 'session.db')
  database('collision', 'contact.db', page(keyB, saltA))
  const collision = verify('collision', [{ keyHex: keyA, saltHex: saltA }, { keyHex: keyB, saltHex: saltA }])
  assert.equal(collision.success, false, 'one salt mapping cannot represent two inconsistent keys')
  assert.equal(collision.verified, 1)
  const tampered = Buffer.from(original); tampered[3999] ^= 1
  database('tamper', 'session.db')
  database('tamper', 'contact.db', tampered)
  assert.equal(verify('tamper').success, false, 'same salt does not authenticate another file')

  const longFile = database('first_page', 'session.db', Buffer.concat([original, Buffer.alloc(65_536, 0xee)]))
  const before = fs.readFileSync(longFile)
  const readRequests = []
  const tracked = loadVerifier({ readSync(fd, buffer, offset, length, position) {
    readRequests.push({ length, position })
    return fs.readSync(fd, buffer, offset, length, position)
  } })
  assert.equal(tracked.verifyWechatKeyCandidates(discover('first_page', tracked), [keyA]).success, true)
  assert.deepEqual(readRequests, [{ length: 4096, position: 0 }])
  assert.deepEqual(fs.readFileSync(longFile), before)
  const unreadable = loadVerifier({ openSync(file, ...args) {
    if (String(file).endsWith('contact.db')) throw Object.assign(new Error('sensitive path'), { code: 'EACCES' })
    return fs.openSync(file, ...args)
  } })
  throwsCode(() => discover('wxid_A', unreadable), 'DATABASE_UNREADABLE')

  // File, directory, account and directly selected storage symlinks are rejected.
  database('linked_file', 'session.db')
  fs.symlinkSync(longFile, path.join(temp, 'linked_file/db_storage/contact.db'))
  throwsCode(() => discover('linked_file'), 'DATABASE_SYMLINK')
  database('linked_directory', 'session.db')
  fs.symlinkSync(path.join(temp, 'wxid_B/db_storage'), path.join(temp, 'linked_directory/db_storage/message'))
  throwsCode(() => discover('linked_directory'), 'DATABASE_SYMLINK')
  fs.symlinkSync(path.join(temp, 'wxid_B'), path.join(temp, 'alias_account'))
  throwsCode(() => verifier.resolveWechatAccount(temp, 'alias_account'), 'DATABASE_SYMLINK')
  throwsCode(() => verifier.resolveWechatAccount(path.join(temp, 'alias_account')), 'DATABASE_SYMLINK')
  throwsCode(() => verifier.resolveWechatAccount(path.join(temp, 'alias_account/db_storage')), 'DATABASE_SYMLINK')
  fs.mkdirSync(path.join(temp, 'alias_storage'))
  fs.symlinkSync(path.join(temp, 'wxid_B/db_storage'), path.join(temp, 'alias_storage/db_storage'))
  throwsCode(() => verifier.resolveWechatAccount(path.join(temp, 'alias_storage')), 'DATABASE_SYMLINK')
  fs.mkdirSync(path.join(temp, 'deep/db_storage', ...Array(9).fill('nested')), { recursive: true })
  throwsCode(() => discover('deep'), 'DATABASE_LIMIT')

  nativeCrossCheck()
  console.log('WeChat per-database raw-key authentication, account boundaries, first-page-only reads, failure closure, bounds and symlinks passed (synthetic only)')
}

function nativeCrossCheck() {
  const libraryPath = path.join(root, 'resources/macos/libWCDB.dylib')
  if (process.platform !== 'darwin' || !fs.existsSync(libraryPath)) {
    console.log('SKIP: native cross-check requires bundled macOS libWCDB.dylib; pure Node checks still ran')
    return
  }
  const lib = require('koffi').load(libraryPath)
  const open = lib.func('int sqlite3_open_v2(const char *filename, _Out_ void **db, int flags, const char *vfs)')
  const close = lib.func('int sqlite3_close_v2(void *db)')
  const keyDatabase = lib.func('int sqlite3_key(void *db, const void *key, int length)')
  const exec = lib.func('int sqlite3_exec(void *db, const char *sql, void *cb, void *arg, void *error)')
  const files = []
  for (const [relative, key, salt] of [['session/session.db', keyA, saltA], ['contact/contact.db', keyB, saltB], ['message/message_0.db', keyB, saltB]]) {
    const file = path.join(temp, 'native/db_storage', relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const handle = [null]
    assert.equal(open(file, handle, 6, null), 0)
    try {
      const material = Buffer.from(`x'${key}${salt}'`, 'ascii')
      assert.equal(keyDatabase(handle[0], material, material.length), 0)
      assert.equal(exec(handle[0], 'PRAGMA cipher_compatibility=4; PRAGMA cipher_page_size=4096;', null, null, null), 0)
      assert.equal(exec(handle[0], 'CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES (\'synthetic\');', null, null, null), 0)
    } finally { assert.equal(close(handle[0]), 0) }
    files.push({ file, before: fs.readFileSync(file) })
  }
  const account = discover('native')
  assert.equal(account.databases.length, 3)
  assert.equal(account.plaintextCount, 0, 'native fixtures must actually be encrypted')
  const partial = verifier.verifyWechatKeyCandidates(account, [{ keyHex: keyA, saltHex: saltA }])
  assert.equal(partial.success, false)
  assert.equal(partial.coreVerified, 1)
  const result = verifier.verifyWechatKeyCandidates(account, [{ keyHex: keyA, saltHex: saltA }, { keyHex: keyB, saltHex: saltB }])
  assert.equal(result.success, true, 'Node HMAC must agree with real SQLCipher 4 encryption')
  assert.equal(result.verified, 3)
  for (const { file, before } of files) assert.deepEqual(fs.readFileSync(file), before, 'authentication leaves encrypted files untouched')
  console.log('Real libWCDB SQLCipher 4 first-page cross-check passed with independent per-database raw keys')
}

try { main() } finally { fs.rmSync(temp, { recursive: true, force: true }) }
