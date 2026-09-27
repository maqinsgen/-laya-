const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

// Simulated utility processes and configuration only. No user data, native
// library, Electron session or real worker is accessed by this regression.
const filename = path.join(__dirname, '../electron/services/wcdbService.ts')
const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText
const primary = '11'.repeat(32)
const otherPrimary = '22'.repeat(32)
const keys = { ['aa'.repeat(16)]: primary, ['bb'.repeat(16)]: '33'.repeat(32) }
const normalize = value => JSON.parse(JSON.stringify(value))
const tick = () => new Promise(resolve => setImmediate(resolve))

function fixture(options = {}) {
  const timers = new Map()
  const workers = []
  const messages = []
  const keyringReads = []
  const logs = []
  const configured = { dbPath: '/synthetic/accounts', decryptKey: primary, myWxid: 'wxid_A', ...options.config }
  let configClosed = 0
  let keyringFailure = options.keyringFailure || false
  let seq = 0
  class Worker extends EventEmitter {
    constructor() {
      super()
      this.pid = 100 + workers.length
      this.stdout = new EventEmitter()
      this.stderr = new EventEmitter()
      this.connected = false
      this.crashNextQuery = false
    }
    postMessage(request) {
      messages.push({ worker: this, ...request })
      queueMicrotask(() => {
        if (request.type === 'execQuery' && this.crashNextQuery) {
          this.crashNextQuery = false
          this.connected = false
          this.emit('exit', 1)
          return
        }
        let result = { success: true }
        if (request.type === 'open') {
          this.active = request.payload
          this.connected = options.legacy
            ? request.payload.databaseKeys === undefined
            : JSON.stringify(request.payload.databaseKeys) === JSON.stringify(keys)
          result = this.connected
        } else if (request.type === 'execQuery') {
          result = this.connected ? { success: true, rows: [{ marker: 'account-A' }] }
            : { success: false, error: 'WCDB 未初始化' }
        } else if (request.type === 'close') {
          this.connected = false
        } else if (request.type === 'shutdown') {
          this.connected = false
          this.emit('exit', 0)
          return
        }
        this.emit('message', { id: request.id, result })
      })
    }
    kill() { this.connected = false; this.emit('exit', 1); return true }
  }
  const dependencies = {
    electron: { utilityProcess: { fork() {
      const worker = new Worker(); workers.push(worker)
      queueMicrotask(() => worker.emit('message', { id: 0, type: 'ready' }))
      return worker
    } } },
    events: { EventEmitter }, fs: { existsSync: () => true }, path,
    './config': { ConfigService: class {
      get(key) { return configured[key] }
      close() { configClosed++ }
    } },
    './runtimePaths': {
      getAppPath: () => '/synthetic/app', getAppVersion: () => 'test',
      getUserDataPath: () => '/synthetic/config', isElectronPackaged: () => false,
    },
    './workerEnvironment': { getElectronWorkerEnv: () => ({}) },
    './wechatKeyring': { loadWechatKeyring(dbPath, wxid, hexKey) {
      keyringReads.push({ dbPath, wxid, hexKey })
      if (keyringFailure) throw new Error('微信逐库密钥无法解密，请在本机重新获取。')
      if (options.legacy) return undefined
      assert.equal(dbPath, configured.dbPath)
      assert.equal(wxid, configured.myWxid)
      assert.equal(hexKey, configured.decryptKey)
      return { ...keys }
    } },
  }
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module, exports: module.exports, Buffer, __dirname: '/synthetic/app/dist-electron',
    process: { platform: 'win32', env: {}, resourcesPath: '/synthetic/resources' },
    console: Object.fromEntries(['log', 'warn', 'info', 'error'].map(level => [level, (...args) => logs.push(args)])),
    setTimeout(callback, ms) { const timer = { id: ++seq, callback, ms }; timers.set(timer.id, timer); return timer },
    clearTimeout(timer) { if (timer) timers.delete(timer.id) },
    require(name) { assert(Object.hasOwn(dependencies, name), `Prohibited dependency: ${name}`); return dependencies[name] },
  }, { filename })
  const service = new module.exports.WcdbService()
  return {
    service, workers, messages, keyringReads, configured, logs,
    setFailure(value) { keyringFailure = value },
    configCloses: () => configClosed,
    opens: () => messages.filter(message => message.type === 'open'),
    async runRestart() {
      const restart = [...timers.values()].find(timer => timer.ms === 2000)
      assert(restart, 'worker exit schedules one bounded restart')
      timers.delete(restart.id); restart.callback()
      for (let index = 0; index < 8; index++) await tick()
    },
    async cleanup() {
      service.shutdown()
      await tick()
      assert.equal(timers.size, 0, 'all scheduled worker lifecycle timers are cleaned up')
      for (const value of Object.values(keys)) assert(!JSON.stringify(logs).includes(value), 'logs omit keys')
    },
  }
}

async function main() {
  const cold = fixture()
  try {
    assert.equal(cold.service.lastOpenPayload, null)
    assert.deepEqual(normalize(await cold.service.execQuery('contact', '', 'SELECT marker FROM sentinel')),
      { success: true, rows: [{ marker: 'account-A' }] }, 'cold query loads persisted per-database keys before opening')
    assert.equal(cold.keyringReads.length, 1)
    assert.equal(cold.configCloses(), 1)
    assert.deepEqual(normalize(cold.opens()[0].payload.databaseKeys), keys)
    assert.equal(cold.opens()[0].payload.wxid, 'wxid_A')
    assert.equal(cold.opens()[0].payload.hexKey, primary)

    cold.workers[0].emit('exit', 1)
    await cold.runRestart()
    assert.equal(cold.workers.length, 2)
    assert.equal(cold.workers[1].connected, true)
    assert.deepEqual(normalize(cold.opens()[1].payload.databaseKeys), keys, 'automatic restart retains the complete account key map')
    assert.equal(cold.keyringReads.length, 1, 'in-memory recovery uses the verified active payload')

    cold.workers[1].crashNextQuery = true
    assert.equal((await cold.service.execQuery('message', 'message_0.db', 'SELECT marker FROM sentinel')).success, true,
      'an in-flight utility exit recovers and retries with the complete map')
    assert.equal(cold.workers.length, 3)
    assert.deepEqual(normalize(cold.opens()[2].payload.databaseKeys), keys)

    cold.service.close()
    await tick()
    assert.equal(cold.service.lastOpenPayload, null)
    assert.equal((await cold.service.execQuery('contact', '', 'SELECT marker FROM sentinel')).success, true)
    assert.equal(cold.keyringReads.length, 2, 'reopening from saved configuration reloads the map after close')
    assert.deepEqual(normalize(cold.opens().at(-1).payload.databaseKeys), keys)
  } finally { await cold.cleanup() }

  for (const mode of ['cold', 'direct-open', 'test-connection']) {
    const failed = fixture({ keyringFailure: true })
    try {
      if (mode === 'cold') {
        assert.equal((await failed.service.execQuery('contact', '', 'SELECT 1')).success, false)
        assert.equal(failed.configCloses(), 1, 'configuration resources close even when keyring decryption fails')
      } else if (mode === 'direct-open') {
        await assert.rejects(failed.service.open(failed.configured.dbPath, primary, 'wxid_A'), /无法解密/)
      } else {
        const result = await failed.service.testConnection(failed.configured.dbPath, primary, 'wxid_A')
        assert.equal(result.success, false)
        assert.match(result.error, /无法解密/)
      }
      assert.equal(failed.opens().length, 0, `${mode}: decryption failure must not fall back to the session raw key`)
      assert.equal(failed.messages.some(message => message.type === 'testConnection'), false,
        'failed keyring decryption never reaches a native connection probe')
      assert.equal(failed.service.lastOpenPayload, null)
    } finally { await failed.cleanup() }
  }

  const live = fixture()
  try {
    assert.equal(await live.service.open(live.configured.dbPath, primary, 'wxid_A'), true)
    const previous = live.service.lastOpenPayload
    live.setFailure(true)
    await assert.rejects(live.service.open('/synthetic/other-account', otherPrimary, 'wxid_B'), /无法解密/)
    assert.equal(live.service.lastOpenPayload, previous, 'failed replacement keyring load preserves the active account recovery map')
    assert.equal(live.workers[0].connected, true)
    live.workers[0].emit('exit', 1)
    await live.runRestart()
    assert.deepEqual(normalize(live.opens().at(-1).payload.databaseKeys), keys,
      'worker recovery retains account A after failed account B keyring decryption')
    assert.equal(live.opens().at(-1).payload.wxid, 'wxid_A')
  } finally { await live.cleanup() }

  const legacy = fixture({ legacy: true })
  try {
    assert.equal((await legacy.service.execQuery('session', '', 'SELECT 1')).success, true)
    assert.equal(legacy.opens()[0].payload.databaseKeys, undefined, 'a genuinely absent keyring preserves existing passphrase support')
  } finally { await legacy.cleanup() }
  console.log('Windows WcdbService cold-start keyring loading, scheduled/in-flight worker recovery, account isolation and fail-closed decryption checks passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
