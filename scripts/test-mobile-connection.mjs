import assert from 'node:assert/strict'
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const result = await build({
  stdin: {
    contents: `export * from './mobile/src/services/webdavSync.ts'; export * from './mobile/src/services/storage.ts'; export * from './src/shared/todoSync.ts';`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  tsconfig: path.join(root, 'mobile/tsconfig.json'),
  plugins: [{
    name: 'mock-capacitor-network',
    setup(builder) {
      builder.onResolve({ filter: /^@capacitor\/core$/ }, () => ({ path: 'network', namespace: 'mock' }))
      builder.onLoad({ filter: /^network$/, namespace: 'mock' }, () => ({
        contents: 'export const CapacitorHttp = { request: (options) => globalThis.__mobileTestRequest(options) }',
        loader: 'js',
      }))
      builder.onResolve({ filter: /^@capacitor\/preferences$/ }, () => ({ path: 'preferences', namespace: 'mock' }))
      builder.onLoad({ filter: /^preferences$/, namespace: 'mock' }, () => ({ contents: 'export const Preferences = globalThis.__mobileTestPreferences', loader: 'js' }))
      builder.onResolve({ filter: /^@aparajita\/capacitor-secure-storage$/ }, () => ({ path: 'secure', namespace: 'mock' }))
      builder.onLoad({ filter: /^secure$/, namespace: 'mock' }, () => ({ contents: 'export const SecureStorage = globalThis.__mobileTestSecureStorage', loader: 'js' }))
    },
  }],
})
const preferences = new Map()
const secure = new Map()
let failKey = ''
globalThis.__mobileTestPreferences = {
  get: async ({ key }) => ({ value: preferences.get(key) ?? null }),
  set: async ({ key, value }) => {
    if (failKey === key) { failKey = ''; throw new Error('fixture storage failure') }
    preferences.set(key, value)
  },
  remove: async ({ key }) => { preferences.delete(key) },
}
globalThis.__mobileTestSecureStorage = {
  setKeyPrefix: async () => {},
  getItem: async (key) => secure.get(key) ?? null,
  setItem: async (key, value) => { secure.set(key, value) },
  removeItem: async (key) => { secure.delete(key) },
}
const { syncWithWebDav, normalizeMobileEndpoint, createEmptyTodoSyncDocument, encryptTodoSyncDocument, decryptTodoSyncEnvelope, saveMobileConnection, loadCredentials, loadLocalDocument, loadMobileConfig } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
const config = { endpoint: 'https://dav.example.invalid/', username: 'fixture-user', remotePath: 'CipherTalk/todos.enc.json', deviceId: 'phone-fixture', lastSyncAt: 0, lastError: '', remindBeforeMinutes: 30, wallpaperAuto: false }
const credentials = { password: 'fixture-app-password', secret: 'fixture-only-sync-secret-12345' }
const local = createEmptyTodoSyncDocument(config.deviceId)
let calls = []
function mock(handler) {
  calls = []
  globalThis.__mobileTestRequest = async (options) => {
    calls.push(options)
    return handler(options)
  }
}
function response(status, data = '', headers = {}) { return { status, data, headers } }

assert.equal(normalizeMobileEndpoint('https://dav.example.invalid/dav'), 'https://dav.example.invalid/dav/')
assert.throws(() => normalizeMobileEndpoint('not a url'), /完整的 WebDAV 地址/)
assert.throws(() => normalizeMobileEndpoint('https://name:password@example.invalid/'), /不要包含用户名或密码/)
assert.throws(() => normalizeMobileEndpoint('http://example.invalid/'), /必须使用 HTTPS/)
assert.equal(normalizeMobileEndpoint('http://[::1]:8080'), 'http://[::1]:8080/')

mock(() => response(404))
await assert.rejects(() => syncWithWebDav(config, credentials, local, { requireExisting: true }), /先在电脑端成功同步一次/)
assert.deepEqual(calls.map(({ method }) => method), ['GET'], 'first connection must not create a remote file at a mistyped path')

for (const status of [401, 403]) {
  mock(() => response(status))
  await assert.rejects(() => syncWithWebDav(config, credentials, local, { requireExisting: true }), /应用专用密码/)
  assert.equal(calls.length, 1, 'invalid credentials must never upload data')
}

mock(() => { throw new Error('private transport internals fixture-app-password') })
await assert.rejects(() => syncWithWebDav(config, credentials, local), (error) => !error.message.includes(credentials.password) && /检查网络/.test(error.message))

mock(() => response(200, '<html>sign in</html>'))
await assert.rejects(() => syncWithWebDav(config, credentials, local, { requireExisting: true }), /不是有效的同步文档/)
assert.equal(calls.length, 1)

const remote = createEmptyTodoSyncDocument('desktop-fixture')
remote.items = [{ id: 'desktop-item', title: 'Review fixture', details: '', dueAt: null, priority: 'high', status: 'pending', sourceType: 'wechat', sourceLabel: 'fixture', sourceRef: 'fixture:1', sourcePreview: 'must remain redacted', confidence: 1, createdAt: 1, updatedAt: 1 }]
const encrypted = await encryptTodoSyncDocument(remote, credentials.secret)
mock(() => response(200, JSON.stringify(encrypted), { ETag: 'version-1' }))
await assert.rejects(() => syncWithWebDav(config, { ...credentials, secret: 'wrong-secret-12345' }, local, { requireExisting: true }), /无法解密/)
assert.equal(calls.length, 1, 'wrong recovery keys must never upload or create remote content')

mock(({ method }) => method === 'GET' ? response(200, JSON.stringify(encrypted), { ETag: 'version-1' }) : response(204))
const success = await syncWithWebDav(config, credentials, local, { requireExisting: true })
assert.equal(success.document.items[0].title, 'Review fixture')
assert.ok(success.config.lastSyncAt > 0)
assert.equal(success.config.lastError, '')
assert.deepEqual(calls.map(({ method }) => method), ['GET', 'PUT'])
assert.equal(calls[1].headers['If-Match'], 'version-1')
const uploaded = await decryptTodoSyncEnvelope(JSON.parse(calls[1].data), credentials.secret)
assert.equal(uploaded.items[0].sourcePreview, '', 'source message excerpts remain redacted on upload')

let gets = 0
mock(({ method }) => method === 'GET' ? (++gets === 1 ? response(200, JSON.stringify(encrypted), { ETag: 'version-1' }) : response(404)) : response(412))
await assert.rejects(() => syncWithWebDav(config, credentials, local, { requireExisting: true }), /未找到电脑端/)
assert.deepEqual(calls.map(({ method }) => method), ['GET', 'PUT', 'GET'], 'first-connection requirement must survive ETag retries')

await saveMobileConnection(config, credentials, local)
assert.deepEqual(await loadCredentials(), credentials)
assert.deepEqual(await loadLocalDocument(config, credentials.secret), local)
const priorPreferences = new Map(preferences)
const priorSecure = new Map(secure)
failKey = 'ciphertalk.todo.mobile.config.v1'
await assert.rejects(() => saveMobileConnection({ ...config, username: 'replacement-fixture' }, { password: 'new-fixture-password', secret: 'new-fixture-secret-12345' }, remote), /已恢复原配置/)
assert.deepEqual(preferences, priorPreferences, 'a failed config write must restore the original encrypted cache')
assert.deepEqual(secure, priorSecure, 'a failed config write must restore the matching recovery key')
assert.deepEqual(await loadMobileConfig(), config)
assert.deepEqual(await loadLocalDocument(config, credentials.secret), local)

delete globalThis.__mobileTestRequest
delete globalThis.__mobileTestPreferences
delete globalThis.__mobileTestSecureStorage
console.log('mobile connection regression checks passed (mock network only)')
