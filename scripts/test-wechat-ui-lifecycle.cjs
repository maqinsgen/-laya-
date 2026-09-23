const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const tick = () => new Promise(resolve => setImmediate(resolve))
const key = 'a1'.repeat(32)
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function harness(page, options = {}) {
  const isWelcome = page === 'WelcomePage'
  const relative = isWelcome ? 'src/pages/WelcomePage.tsx' : 'src/components/settings/tabs/DatabaseTab.tsx'
  let source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8')
  const parsed = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const component = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === page)
  const renderReturn = component.body.statements.find(node => ts.isReturnStatement(node))
  // Expose actual component handlers for a deterministic hook harness, replacing
  // only its final JSX return. No application/native/WeChat code is executed.
  const exposed = isWelcome
    ? 'handleAutoGetDbKey, handleCancelDbKey, verifyAccountDirectory, setDbPath, setDecryptKey, setWxid'
    : 'handleGetKey, handleCancelGetKey, handleVerifyAccountDirectory, setDbPath, setDecryptKey, setWxid'
  source = source.slice(0, renderReturn.getStart(parsed)) + `return { ${exposed} }` + source.slice(renderReturn.end)
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const slots = []
  const writes = []
  const effects = []
  let cursor = 0
  const react = {
    useState(initial) {
      const index = cursor++
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial }
      return [slots[index].value, value => {
        slots[index].value = typeof value === 'function' ? value(slots[index].value) : value
        writes.push(['state', index, slots[index].value])
      }]
    },
    useRef(initial) {
      const index = cursor++
      if (!slots[index]) slots[index] = { current: initial }
      return slots[index]
    },
    useEffect(effect, deps) {
      const index = cursor++
      const previous = slots[index]
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
        slots[index] = { deps, cleanup: previous?.cleanup }
        effects.push(() => {
          slots[index].cleanup?.()
          slots[index].cleanup = effect()
        })
      }
    },
  }
  const storage = new Map(options.cached === undefined ? [] : [['welcomeConfig', options.cached]])
  const config = { dbPath: '/mock/data', decryptKey: '', wxid: '', editingAccountId: 'account-1' }
  const settings = {
    config, initialConfig: { ...config },
    setField(name, value) { config[name] = value; writes.push(['field', name, value]) },
    rebaseFields(values) { Object.assign(config, values); writes.push(['rebase', values]) },
  }
  const useSettingsStore = selector => selector(settings)
  useSettingsStore.getState = () => settings
  let starts = 0, cancels = 0
  const listeners = new Set()
  const api = {
    app: { getPlatformInfo: async () => ({ platform: 'darwin', arch: 'arm64' }) },
    wxKey: {
      onStatus: fn => { listeners.add(fn); return () => listeners.delete(fn) },
      startGetKey: async () => { starts++; return options.start ? options.start() : { success: true, key } },
      cancel: async () => { cancels++; return options.cancel ? options.cancel() : true },
      detectCurrentAccount: async () => options.detect ? options.detect() : null,
    },
    wcdb: {
      resolveValidWxid: async () => options.resolve ? options.resolve() : { success: false },
      testConnection: async () => options.verify ? options.verify() : { success: true },
    },
    dbPath: {
      getBestCachePath: async () => ({ success: false }),
      scanWxids: async () => options.scan ? options.scan() : [],
    },
  }
  const sanitizeWechatSetupDraft = value => Object.fromEntries(['dbPath', 'cachePath', 'wxid'].map(name => [name, typeof value?.[name] === 'string' ? value[name] : '']))
  const deps = {
    react,
    'react/jsx-runtime': {},
    'react-router-dom': { useNavigate: () => () => {}, useLocation: () => ({ search: options.addAccount ? '?mode=add-account' : '' }) },
  }
  const mockRequire = name => {
    if (deps[name]) return deps[name]
    if (name.endsWith('/appStore')) return { useAppStore: () => ({}) }
    if (name.endsWith('/authStore')) return { useAuthStore: () => ({}) }
    if (name.endsWith('/settingsStore')) return { useSettingsStore, hasSettingsChanges: () => false }
    if (name.endsWith('/WechatReadiness')) return { useWechatReadiness: () => ({ checking: false, refresh: async () => ({ canAutoGet: true }) }) }
    if (name.endsWith('/wechatSetup')) return { isValidDatabaseKey: value => /^[a-f0-9]{64}$/i.test(value), normalizeDatabaseKey: value => value.trim(), sanitizeWechatSetupDraft }
    if (name.endsWith('/config')) return { listAccounts: async () => [], getActiveAccount: async () => null }
    if (name.endsWith('/ipc')) return { dialog: {} }
    if (name.endsWith('/brand')) return { BRAND: {} }
    return {}
  }
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module, exports: module.exports, require: mockRequire, URLSearchParams,
    console: { error: (...args) => writes.push(['log', ...args]) },
    localStorage: {
      getItem: name => storage.get(name) ?? null,
      setItem: (name, value) => storage.set(name, value),
      removeItem: name => storage.delete(name),
    },
    window: { electronAPI: api, navigator: { platform: 'MacIntel' }, clearTimeout },
  }, { filename: relative })
  const render = () => {
    cursor = 0
    const handlers = module.exports.default({ showMessage: (...args) => writes.push(['message', ...args]) })
    while (effects.length) effects.shift()()
    return handlers
  }
  let handlers = render()
  return {
    async ready() {
      await tick()
      handlers.setDbPath('/mock/data')
      handlers = render()
      await tick()
      return handlers
    },
    render, writes, storage, config,
    unmount() { for (const slot of slots) slot?.cleanup?.() },
    stats: () => ({ starts, cancels, listeners: listeners.size }),
    get handlers() { return handlers },
  }
}

async function testCancelledStage(page, stage) {
  const pending = deferred()
  const options = { [stage]: () => pending.promise }
  if (stage === 'verify') options.start = () => ({ success: true, key, account: { wxid: 'candidate' } })
  const app = harness(page, options)
  const handlers = await app.ready()
  const run = page === 'WelcomePage' ? handlers.handleAutoGetDbKey : handlers.handleGetKey
  const cancel = page === 'WelcomePage' ? handlers.handleCancelDbKey : handlers.handleCancelGetKey
  const first = run()
  await tick()
  await cancel()
  const afterCancel = app.writes.length
  if (stage === 'resolve') pending.resolve({ success: true, wxid: 'late-account' })
  else if (stage === 'verify') pending.resolve({ success: true })
  else if (stage === 'detect') pending.resolve({ wxid: 'late-account' })
  else if (stage === 'scan') pending.resolve(['late-account'])
  else pending.resolve({ success: true, key, validatedWxid: 'late-account' })
  await first
  assert.equal(app.writes.length, afterCancel, `${page}: ${stage} must not write after cancellation`)
  app.unmount()
}

async function main() {
  for (const page of ['WelcomePage', 'DatabaseTab']) {
    for (const stage of ['start', 'resolve', 'detect', 'scan']) await testCancelledStage(page, stage)
    const pending = deferred()
    const app = harness(page, { start: () => pending.promise })
    const handlers = await app.ready()
    const run = page === 'WelcomePage' ? handlers.handleAutoGetDbKey : handlers.handleGetKey
    const first = run()
    const duplicate = run()
    await tick()
    assert.equal(app.stats().starts, 1, `${page}: repeated clicks must share the synchronous lock`)
    app.unmount()
    const writesAtUnmount = app.writes.length
    pending.resolve({ success: true, key, validatedWxid: 'late-account' })
    await Promise.all([first, duplicate])
    assert.equal(app.writes.length, writesAtUnmount, `${page}: unmounted work cannot write state/store`)
    assert.equal(app.stats().cancels, 1)
    assert.equal(app.stats().listeners, 0)

    const oldResult = deferred()
    const newResult = deferred()
    const cancelResult = deferred()
    let call = 0
    const retry = harness(page, {
      start: () => (++call === 1 ? oldResult.promise : newResult.promise),
      cancel: () => cancelResult.promise,
    })
    const retryHandlers = await retry.ready()
    const begin = page === 'WelcomePage' ? retryHandlers.handleAutoGetDbKey : retryHandlers.handleGetKey
    const stop = page === 'WelcomePage' ? retryHandlers.handleCancelDbKey : retryHandlers.handleCancelGetKey
    const oldRun = begin()
    await tick()
    const stopping = stop()
    await begin()
    assert.equal(retry.stats().starts, 1, `${page}: keep the lock until cancellation is acknowledged`)
    cancelResult.resolve(true)
    await stopping
    const newRun = begin()
    await tick()
    const beforeOldFailure = retry.writes.length
    oldResult.reject(new Error('late failure'))
    await oldRun
    assert.equal(retry.writes.length, beforeOldFailure, `${page}: old catch/finally must not change the new request`)
    newResult.resolve({ success: true, key, validatedWxid: 'current-account' })
    await newRun
    assert.equal(retry.stats().starts, 2)
    retry.unmount()
  }
  await testCancelledStage('WelcomePage', 'verify')

  const legacy = harness('WelcomePage', { addAccount: true, cached: JSON.stringify({ dbPath: '/old', decryptKey: key, imageAesKey: key, phone: 'private' }) })
  await legacy.ready()
  const saved = JSON.parse(legacy.storage.get('welcomeConfig'))
  assert.equal(saved.dbPath, '/old')
  assert.equal(saved.decryptKey, undefined)
  assert.equal(saved.imageAesKey, undefined)
  assert.equal(saved.phone, undefined)
  legacy.unmount()
  const malformed = harness('WelcomePage', { addAccount: true, cached: `{"decryptKey":"${key}"` })
  await malformed.ready()
  assert.equal(malformed.storage.has('welcomeConfig'), false)
  assert.equal(JSON.stringify(malformed.writes).includes(key), false)
  malformed.unmount()

  const verify = deferred()
  const database = harness('DatabaseTab', { verify: () => verify.promise })
  const handlers = await database.ready()
  handlers.setDecryptKey(key)
  handlers.setWxid('account-old')
  const current = database.render()
  const pendingVerify = current.handleVerifyAccountDirectory()
  current.setWxid('account-new')
  const afterEdit = database.writes.length
  verify.resolve({ success: true })
  await pendingVerify
  assert.equal(database.writes.slice(afterEdit).some(write => write[0] === 'message'), false, 'old verification must not validate another account')
  database.unmount()
  console.log('WeChat UI cancellation, lifecycle, duplicate-start and legacy-draft checks passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
