// Synthetic database pages and mocked authorization only. No native debugger,
// administrator prompt, running application, or user data is accessed.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')
const ts = require('typescript')

const source = path.join(__dirname, '../electron/services/wechatLoginCaptureService.ts')
const moduleObject = { exports: {} }
vm.runInNewContext(ts.transpileModule(fs.readFileSync(source, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, {
  module: moduleObject, exports: moduleObject.exports,
  require: name => name === 'electron' ? { app: { isPackaged: false, getAppPath: () => path.dirname(__dirname) } } : require(name),
  process, Buffer, setTimeout, clearTimeout, console,
}, { filename: source })
const { WechatLoginCaptureService, findLoginCaptureAccounts, verifyLoginCapturePage } = moduleObject.exports
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'notewake-capture-contracts-'))
const secret = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1))
const otherSecret = Buffer.alloc(32, 11)
let passed = 0

function page(password, saltByte) {
  const salt = Buffer.alloc(16, saltByte)
  const key = crypto.pbkdf2Sync(password, salt, 256000, 32, 'sha512')
  const macKey = crypto.pbkdf2Sync(key, Buffer.from(salt.map(byte => byte ^ 0x3a)), 2, 32, 'sha512')
  const body = Buffer.alloc(4016, 17)
  const pageNumber = Buffer.alloc(4); pageNumber.writeUInt32LE(1)
  return Buffer.concat([salt, body, crypto.createHmac('sha512', macKey).update(body).update(pageNumber).digest()])
}
const good = page(secret, 7), other = page(otherSecret, 9)
function account(name, pages = { 'session.db': good }) {
  const directory = path.join(temporary, name, 'db_storage')
  fs.mkdirSync(directory, { recursive: true })
  for (const [name, data] of Object.entries(pages)) fs.writeFileSync(path.join(directory, name), data)
  return directory
}
function privateJson(filename, value, mode = 0o600) { fs.writeFileSync(filename, JSON.stringify(value), { mode }); fs.chmodSync(filename, mode) }
const normalAccount = account('account_one')

function mockService(behavior = 'success') {
  const service = new WechatLoginCaptureService({ authorization: 40, monitor: 1000, cleanup: 150, poll: 5 })
  const seen = { calls: 0, killed: 0, directory: null, statuses: [] }
  service.runtimeDetails = async () => ({ directory: '/synthetic-resource', python: '/synthetic-python' })
  service.findTarget = async () => ({ pid: 45678, executable: '/synthetic/WeChat.app/Contents/MacOS/WeChat', startTime: 'SYNTHETIC_START' })
  service.authorize = (_runtime, requestFile) => {
    seen.calls++
    seen.directory = path.dirname(requestFile)
    const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'))
    assert.equal(fs.statSync(seen.directory).mode & 0o777, 0o700)
    assert.equal(fs.statSync(requestFile).mode & 0o777, 0o600)
    assert.equal(fs.readFileSync(path.join(seen.directory, 'active'), 'utf8'), request.requestId)
    assert.equal(request.pid, 45678)
    assert.ok(request.salts.length > 0)
    let finish
    const done = new Promise(resolve => { finish = resolve })
    const publish = (filename, value, mode) => { if (fs.existsSync(seen.directory)) privateJson(path.join(seen.directory, filename), value, mode) }
    const complete = (stage, captured, detached) => {
      publish('completion.json', { finished: true, stage, captured, detached })
      finish('OK')
    }
    if (behavior === 'authorization_wait') return { child: { kill: () => { seen.killed++; finish('') } }, done }
    if (behavior === 'authorization_denied') {
      queueMicrotask(() => finish('ERR:-128'))
      return { child: { kill: () => { seen.killed++ } }, done }
    }
    publish('progress.json', { stage: 'ready', captured: false, detached: false })
    if (behavior === 'cancel' || behavior === 'cancel_late_candidate') {
      const timer = setInterval(() => {
        if (!fs.existsSync(path.join(seen.directory, 'active'))) {
          clearInterval(timer)
          if (behavior === 'cancel_late_candidate') publish('candidate.json', { passphrase: secret.toString('hex') })
          complete(behavior === 'cancel' ? 'cancelled' : 'detached', behavior !== 'cancel', true)
        }
      }, 2)
    } else {
      setTimeout(() => {
        if (behavior === 'detach_failed') return complete('detach_failed', false, false)
        publish('candidate.json', { passphrase: secret.toString('hex') }, behavior === 'insecure_candidate' ? 0o644 : 0o600)
        publish('progress.json', { stage: 'detached', captured: true, detached: true })
        complete('detached', true, true)
      }, 15)
    }
    return { child: { kill: () => { seen.killed++ } }, done }
  }
  return { service, seen }
}
async function capture(mock, options = {}) {
  const statuses = []
  const result = await mock.service.capture({ dbPath: normalAccount, ...options, onStatus: (text, level) => {
    statuses.push(text)
    options.onStatus?.(text, level)
  } })
  assert.ok(statuses.every(text => !/[0-9a-f]{32,}/i.test(text)), 'status must never include candidate or salts')
  if (mock.seen.directory) assert.equal(fs.existsSync(mock.seen.directory), false, 'private temporary files must be removed')
  return { result, statuses }
}

async function main() {
  assert.equal(await verifyLoginCapturePage(secret, good), true)
  assert.equal(await verifyLoginCapturePage(otherSecret, good), false)
  assert.equal(await verifyLoginCapturePage(secret, good.subarray(0, 4095)), false)
  const corrupted = Buffer.from(good); corrupted[4016] ^= 1
  assert.equal(await verifyLoginCapturePage(secret, corrupted), false)
  passed++

  const initial = mockService()
  const success = await capture(initial)
  assert.equal(success.result.success, true)
  assert.equal(success.result.key, secret.toString('hex'))
  assert.equal(success.result.validatedWxid, 'account_one')
  assert.ok(success.statuses.includes('监听已就绪，现在可以登录微信，并在手机上确认。'))
  passed++

  for (const wxid of ['../outside', '/private/outside', '..', 'outside\\account', 'other_account']) {
    const test = mockService()
    const { result } = await capture(test, { wxid })
    assert.equal(result.success, false)
    assert.equal(test.seen.calls, 0)
  }
  assert.equal((await findLoginCaptureAccounts(path.dirname(normalAccount), 'account_one')).length, 1)
  passed++

  const mixed = account('mixed', { 'session.db': good, 'other.db': other })
  const partial = await capture(mockService(), { dbPath: mixed })
  assert.equal(partial.result.success, false)
  assert.equal(partial.result.key, undefined, 'a non-core DB failure also rejects account-wide credentials')
  passed++

  const multiRoot = path.join(temporary, 'multi')
  account('multi/one', { 'session.db': good })
  account('multi/two', { 'session.db': other })
  const selected = await capture(mockService(), { dbPath: multiRoot })
  assert.equal(selected.result.success, true)
  assert.equal(selected.result.validatedWxid, 'one', 'every account must be verified separately')
  passed++

  for (const behavior of ['authorization_wait', 'authorization_denied']) {
    const test = mockService(behavior)
    const { result } = await capture(test)
    assert.equal(result.success, false)
    assert.match(result.error, /授权/)
    if (behavior === 'authorization_wait') assert.equal(test.seen.killed, 1)
  }
  passed++

  const authCancelled = mockService('authorization_wait')
  const authAbort = new AbortController()
  const authPending = capture(authCancelled, { signal: authAbort.signal })
  while (!authCancelled.seen.calls) await new Promise(resolve => setTimeout(resolve, 1))
  authAbort.abort()
  const authResult = await authPending
  assert.equal(authResult.result.success, false)
  assert.match(authResult.result.error, /取消/)
  assert.equal(authCancelled.seen.killed, 1)
  passed++

  for (const behavior of ['cancel', 'cancel_late_candidate']) {
    const controller = new AbortController()
    const test = mockService(behavior)
    const { result } = await capture(test, { signal: controller.signal, onStatus: text => {
      if (text.includes('监听已就绪')) controller.abort()
    } })
    assert.equal(result.success, false)
    assert.equal(result.key, undefined)
    assert.match(result.error, /取消/)
  }
  passed++

  const controller = new AbortController()
  const { result: duringVerification } = await capture(mockService(), { signal: controller.signal, onStatus: text => {
    if (text.includes('逐库验证')) controller.abort()
  } })
  assert.equal(duringVerification.success, false)
  assert.equal(duringVerification.key, undefined)
  passed++

  const failed = mockService('detach_failed')
  const { result: cleanupFailure } = await capture(failed)
  assert.equal(cleanupFailure.success, false)
  assert.match(cleanupFailure.error, /安全结束/)
  assert.equal(failed.service.unsafePid, 45678)
  passed++

  const insecure = await capture(mockService('insecure_candidate'))
  assert.equal(insecure.result.success, false)
  assert.equal(insecure.result.key, undefined)
  passed++

  const busy = mockService()
  const pending = capture(busy)
  const duplicate = await busy.service.capture({ dbPath: normalAccount })
  assert.equal(duplicate.success, false)
  assert.match(duplicate.error, /正在运行/)
  await pending
  assert.equal(busy.seen.calls, 1)
  passed++

  const abortDuringCleanup = new AbortController()
  const originalRm = fs.promises.rm
  let finalDirectory
  fs.promises.rm = async (directory, options) => {
    finalDirectory = directory
    assert.equal(fs.existsSync(path.join(directory, 'candidate.json')), false, 'candidate must be erased before final cleanup')
    await new Promise(resolve => setTimeout(resolve, 5))
    abortDuringCleanup.abort()
    return originalRm(directory, options)
  }
  try {
    const result = await mockService().service.capture({ dbPath: normalAccount, signal: abortDuringCleanup.signal })
    assert.equal(result.success, false)
    assert.equal(result.key, undefined, 'cancel during cleanup cannot return an already assembled key')
    assert.match(result.error, /取消/)
    assert.equal(fs.existsSync(finalDirectory), false)
  } finally { fs.promises.rm = originalRm }
  passed++

  const originalUnlink = fs.promises.unlink
  fs.promises.unlink = async filename => {
    if (String(filename).endsWith('/candidate.json')) throw Object.assign(new Error('synthetic denied'), { code: 'EACCES' })
    return originalUnlink(filename)
  }
  try {
    const result = await capture(mockService())
    assert.equal(result.result.success, false)
    assert.equal(result.result.key, undefined)
    assert.match(result.result.error, /临时密钥文件未能安全清理/)
  } finally { fs.promises.unlink = originalUnlink }
  passed++

  let retainedDirectory
  fs.promises.rm = async directory => {
    retainedDirectory = directory
    assert.equal(fs.existsSync(path.join(directory, 'candidate.json')), false, 'no candidate remains even when directory cleanup fails')
    throw Object.assign(new Error('synthetic denied'), { code: 'EACCES' })
  }
  try {
    const result = await mockService().service.capture({ dbPath: normalAccount })
    assert.equal(result.success, false)
    assert.equal(result.key, undefined)
    assert.match(result.error, /临时密钥文件未能安全清理/)
  } finally {
    fs.promises.rm = originalRm
    if (retainedDirectory) await originalRm(retainedDirectory, { recursive: true, force: true })
  }
  passed++
  console.log(`wechat login capture contracts: ${passed} groups passed (synthetic only)`)
}
main().finally(() => fs.rmSync(temporary, { recursive: true, force: true })).catch(error => { console.error(error); process.exitCode = 1 })
