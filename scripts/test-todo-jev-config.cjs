const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function loadTs(relativePath, dependencies = {}) {
  const filename = path.join(__dirname, '..', relativePath)
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require: name => {
      if (Object.hasOwn(dependencies, name)) return dependencies[name]
      throw new Error(`Unexpected dependency: ${name}`)
    },
    Buffer, URL, Error, process: { platform: 'linux' },
  }, { filename })
  return module.exports
}
const shared = loadTs('src/shared/todoJevConfig.ts')
const fixtureKey = 'test-only-key-must-never-be-exposed'
let stored = { enabled: false, endpoint: shared.DEFAULT_JEV_ENDPOINT, model: shared.DEFAULT_JEV_MODEL, encryptedApiKey: '' }
let writes = 0
let decryptions = 0
let networkCalls = 0
let secureAvailable = true
let storageBackend = 'keychain'
let testError = null
let runtimeReceived = null
let readError = null
const loaded = loadTs('electron/services/todoJevConfigService.ts', {
  electron: { safeStorage: {
    isEncryptionAvailable: () => secureAvailable,
    getSelectedStorageBackend: () => storageBackend,
    encryptString: text => Buffer.from(`encrypted-fixture:${text}`),
    decryptString: bytes => { decryptions++; return bytes.toString().replace(/^encrypted-fixture:/, '') },
  } },
  './config': { ConfigService: class {
    get(key) { assert.equal(key, 'todoJevConfig', 'must never read the general AI provider key'); if (readError) throw readError; return stored }
    set(key, value) { assert.equal(key, 'todoJevConfig'); writes++; stored = value }
    close() {}
  } },
  './todoJevService': { testTodoJevConnection: async runtime => { networkCalls++; runtimeReceived = runtime; if (testError) throw testError } },
  '../../src/shared/todoJevConfig': shared,
})
const service = loaded.todoJevConfigService
const input = (patch = {}) => ({ enabled: false, endpoint: shared.DEFAULT_JEV_ENDPOINT, model: shared.DEFAULT_JEV_MODEL, ...patch })
const plain = value => JSON.parse(JSON.stringify(value))

async function main() {
  assert.equal(service.getState().backend, 'jev', 'old saved configs without backend remain Jev')
  assert.equal(service.getState().enabled, false)
  assert.equal(service.getState().hasApiKey, false)
  assert.equal(service.getRuntimeConfig(), null)
  assert.equal(decryptions, 0, 'disabled mode does not decrypt any key')
  assert.equal(networkCalls, 0, 'reading configuration never calls Jev')
  assert.throws(() => service.configure(input({ enabled: true })), /填写独立的 API Key/)
  assert.equal(writes, 0)

  const saved = service.configure(input({ enabled: true, apiKey: fixtureKey }))
  assert.equal(saved.hasApiKey, true)
  assert.equal(saved.enabled, true)
  assert.equal(JSON.stringify(saved).includes(fixtureKey), false)
  assert.equal(Object.hasOwn(saved, 'apiKey'), false)
  assert.equal(Object.hasOwn(saved, 'encryptedApiKey'), false)
  assert.equal(stored.encryptedApiKey.includes(fixtureKey), false, 'persist encrypted credentials, never plaintext')
  assert.equal(networkCalls, 0, 'saving configuration must never perform a connectivity test')
  const beforeRead = decryptions
  service.getState()
  assert.equal(decryptions, beforeRead, 'renderer state needs only hasApiKey')
  assert.deepEqual(plain(service.getRuntimeConfig()), { backend: 'jev', endpoint: shared.DEFAULT_JEV_ENDPOINT, model: shared.DEFAULT_JEV_MODEL, apiKey: fixtureKey })

  const oldStored = { ...stored }
  const beforeChangedEndpoint = decryptions
  assert.throws(() => service.configure(input({ endpoint: 'https://other.example.invalid/alpha/decisions' })), /旧密钥不会发送到新地址/)
  assert.deepEqual(plain(stored), oldStored)
  assert.equal(decryptions, beforeChangedEndpoint)
  const blockedTest = await service.test(input({ endpoint: 'https://other.example.invalid/alpha/decisions' }))
  assert.equal(blockedTest.success, false)
  assert.equal(networkCalls, 0)
  assert.equal(decryptions, beforeChangedEndpoint, 'changed destinations do not even decrypt the existing key')

  let beforeTestWrites = writes
  assert.equal((await service.test(input())).success, true)
  assert.equal(networkCalls, 1)
  assert.equal(runtimeReceived.apiKey, fixtureKey)
  assert.equal(writes, beforeTestWrites, 'testing never persists the form')
  assert.equal((await service.test(input({ endpoint: 'https://other.example.invalid/alpha/decisions', apiKey: 'other-test-only-key' }))).success, true)
  assert.equal(runtimeReceived.endpoint, 'https://other.example.invalid/alpha/decisions')
  assert.equal(runtimeReceived.apiKey, 'other-test-only-key')
  assert.equal(writes, beforeTestWrites)
  assert.deepEqual(plain(stored), oldStored, 'test with unsaved key cannot alter the saved destination')

  testError = new Error(`Authorization: Bearer ${fixtureKey}; response body contains fixture-user-content`)
  const failedTest = await service.test(input())
  assert.equal(failedTest.success, false)
  assert.equal(JSON.stringify(failedTest).includes(fixtureKey), false)
  assert.equal(JSON.stringify(failedTest).includes('fixture-user-content'), false)
  testError = null
  readError = new Error(`bad storage ${fixtureKey}`)
  assert.equal((await service.test(input())).error.includes(fixtureKey), false, 'storage exceptions must also be sanitized')
  readError = null

  for (const endpoint of ['http://remote.example.invalid/decisions', 'https://user:password@example.invalid/api', 'https://example.invalid/api?token=private', 'https://example.invalid/api#fragment']) {
    assert.throws(() => service.configure(input({ endpoint, apiKey: fixtureKey })), /完整的 HTTPS/)
  }
  assert.throws(() => service.configure(input({ model: 'bad\nmodel', apiKey: fixtureKey })), /模型名称/)
  assert.throws(() => service.configure(input({ apiKey: 'bad\nkey' })), /Key 格式/)
  assert.throws(() => service.configure(input({ apiKey: fixtureKey, clearApiKey: true })), /清空新密钥/)
  secureAvailable = false
  assert.throws(() => service.configure(input({ apiKey: 'new-fixture-key' })), /系统安全存储不可用/)
  secureAvailable = true
  storageBackend = 'basic_text'
  assert.throws(() => service.configure(input({ apiKey: 'new-fixture-key' })), /系统安全存储不可用/)
  storageBackend = 'keychain'

  service.configure(input({ enabled: false }))
  const beforeDisabled = decryptions
  assert.equal(service.getRuntimeConfig(), null)
  assert.equal(decryptions, beforeDisabled)
  service.configure(input({ endpoint: 'https://other.example.invalid/alpha/decisions', clearApiKey: true }))
  assert.equal(service.getState().hasApiKey, false)
  assert.equal(service.getState().enabled, false)
  assert.equal(stored.encryptedApiKey, '')
  stored = { ...stored, enabled: true }
  assert.throws(() => service.getRuntimeConfig(), /独立的 API Key/)
  stored = undefined
  const fresh = service.getState()
  assert.equal(fresh.backend, 'laya')
  assert.equal(fresh.enabled, false)
  assert.equal(fresh.endpoint, shared.DEFAULT_LAYA_ENDPOINT)
  assert.equal(fresh.model, 'multilingual')
  assert.equal(fresh.hasApiKey, false)
  const localInput = { enabled: true, backend: 'laya', endpoint: shared.DEFAULT_LAYA_ENDPOINT, model: shared.DEFAULT_LAYA_MODEL }
  secureAvailable = false
  const beforeLocalDecrypt = decryptions
  service.configure(localInput)
  assert.deepEqual(plain(service.getRuntimeConfig()), { backend: 'laya', endpoint: shared.DEFAULT_LAYA_ENDPOINT, model: 'multilingual', apiKey: '' })
  assert.equal(decryptions, beforeLocalDecrypt, 'loopback Laya does not touch unavailable secure storage when no key exists')
  assert.equal((await service.test(localInput)).success, true)
  assert.equal(runtimeReceived.apiKey, '')
  assert.equal(runtimeReceived.backend, 'laya')
  const beforeRemoteTest = networkCalls
  assert.equal((await service.test({ ...localInput, endpoint: 'https://laya.example.invalid/v1/systemone' })).success, false)
  assert.equal(networkCalls, beforeRemoteTest, 'remote Laya never receives an anonymous request')
  assert.throws(() => service.configure({ ...localInput, endpoint: 'https://laya.example.invalid/v1/systemone' }), /独立的 API Key/)
  assert.throws(() => service.configure({ ...localInput, endpoint: 'http://192.168.1.2:8000/v1/systemone' }), /完整的 HTTPS/)
  assert.throws(() => service.configure({ ...localInput, model: 'laya' }), /英语模型/)
  assert.throws(() => service.configure({ ...localInput, model: 'not-real-multilingual-alias' }), /multilingual/)
  assert.equal(shared.isLocalTodoDecisionEndpoint('http://127.0.0.1:8000/v1/systemone'), true)
  assert.equal(shared.isLocalTodoDecisionEndpoint('http://[::1]:8000/v1/systemone'), true)
  assert.equal(shared.isLocalTodoDecisionEndpoint('https://localhost.evil.invalid/v1/systemone'), false)
  assert.equal(shared.todoDecisionRequiresApiKey('jev', shared.DEFAULT_LAYA_ENDPOINT), true)
  secureAvailable = true
  service.configure(input({ enabled: true, backend: 'jev', apiKey: fixtureKey }))
  assert.throws(() => service.configure(localInput), /旧密钥不会发送/)
  const beforeSwitchDecrypt = decryptions
  service.configure({ ...localInput, clearApiKey: true })
  assert.equal(service.getState().backend, 'laya')
  assert.equal(service.getState().hasApiKey, false)
  assert.equal(service.getRuntimeConfig().apiKey, '')
  assert.equal(decryptions, beforeSwitchDecrypt, 'switching to local Laya explicitly clears rather than decrypts the old cloud key')
  console.log('Laya/Jev configuration tests passed (mock storage and network only)')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
