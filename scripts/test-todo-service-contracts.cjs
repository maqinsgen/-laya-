// Exercise the actual service and IPC code without opening personal databases,
// connecting an account, or calling a paid model.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createHash } = require('node:crypto')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
let data
let dirty = 0
let syncing = false
let generationCount = 0
let generationFailure = false
let generationResponder = null
let providerConfigured = true
let providerResolutionCount = 0
let jevEnabled = false
let jevBackend = 'jev'
let jevRequests = []
let jevResponder = null
let notificationCount = 0
let chatMessages = []
let dropNextConfigWrite = null
const handlers = new Map()
class ConfigService {
  get(key) { return clone(data[key]) }
  set(key, value) {
    if (dropNextConfigWrite?.(key, value)) {
      dropNextConfigWrite = null
      return // Real ConfigService can log a failed write without throwing.
    }
    data[key] = clone(value)
  }
  close() {}
  getAICurrentProvider() { return 'test-provider' }
  getAIProviderConfig() { return providerConfigured ? { apiKey: 'test-key', model: 'test-model' } : {} }
}
const googleService = {
  getState: () => ({ configured: false, connected: false }),
  collectGmailMessages: async () => [],
  collectDriveMessages: async () => [],
}
const syncService = { getState: () => ({ syncing }), start() {} }
const jevConfigService = {
  getState: () => ({ enabled: jevEnabled, backend: jevBackend, hasApiKey: jevEnabled && jevBackend !== 'laya', endpoint: jevBackend === 'laya' ? 'http://127.0.0.1:8000/v1/systemone' : 'https://jev.invalid/decisions/systemone', model: jevBackend === 'laya' ? 'multilingual' : 'test-jev' }),
  getRuntimeConfig: () => jevEnabled ? { ...jevConfigService.getState(), apiKey: jevBackend === 'laya' ? '' : 'synthetic-no-network-key' } : null,
}
function jevResponse(questions, choose = (id, allowed) => id.endsWith('_value') ? 'action' : allowed.find(value => !['none', 'uncertain'].includes(value)) || 'none') {
  return {
    answers: Object.fromEntries(Object.entries(questions).map(([id, question]) => {
      const allowed = Object.keys(question.criteria)
      const choice = choose(id, allowed)
      return [id, { type: 'choice', choice, confidence: .98, probabilities: Object.fromEntries(allowed.map(value => [value, value === choice ? 1 : 0])) }]
    })),
    usage: { input_tokens: 90, output_tokens: 18 },
  }
}
class MockNotification {
  static isSupported() { return true }
  show() { notificationCount++ }
}
const overrides = new Map([
  ['electron', { Notification: MockNotification, safeStorage: {}, shell: {}, dialog: {}, ipcMain: { handle: (name, fn) => handlers.set(name, fn) } }],
  ['sharp', () => { throw new Error('Unexpected wallpaper call') }],
  ['ai', { generateText: async ({ prompt }) => {
    generationCount++
    if (generationFailure) throw new Error('simulated provider failure')
    const payload = JSON.parse(prompt.split('待分析消息 JSON：\n')[1])
    if (generationResponder) return generationResponder(payload)
    return {
      text: JSON.stringify(payload.map((message) => ({ messageKey: message.messageKey, title: '确认合同', kind: 'action', topics: ['交付'], importance: 80, evidenceQuote: message.text, dateCandidateId: null, confidence: .95 }))),
      totalUsage: { inputTokens: 120, outputTokens: 24 },
    }
  } }],
  ['imapflow', { ImapFlow: class { constructor() { throw new Error('Unexpected mail connection') } } }],
  ['mailparser', {}],
  [path.join(root, 'electron/services/config'), { ConfigService }],
  [path.join(root, 'electron/services/chatService'), { chatService: {
    getSessions: async () => ({ success: true, sessions: [{ username: 'test-room', displayName: '项目组', lastTimestamp: Math.floor(Date.now() / 1000) + 100 }] }),
    getNewMessages: async () => ({ success: true, messages: chatMessages }),
  } }],
  [path.join(root, 'electron/services/runtimePaths'), { getUserDataPath: () => { throw new Error('Unexpected disk access') } }],
  [path.join(root, 'electron/services/agent/provider'), { createLanguageModel: () => ({}) }],
  [path.join(root, 'electron/services/agent/resolveProviderConfig'), { resolveProviderConfig: () => {
    providerResolutionCount++
    if (!providerConfigured) throw new Error('generic LLM is not configured')
    return { name: 'test-provider', model: 'test-model' }
  } }],
  [path.join(root, 'electron/services/todoSyncService'), { todoSyncService: syncService, markTodoSyncDirty: () => dirty++ }],
  [path.join(root, 'electron/services/todoGoogleService'), { todoGoogleService: googleService }],
  [path.join(root, 'electron/services/todoJevConfigService'), { todoJevConfigService: jevConfigService, todoJevConfigErrorMessage: () => 'synthetic Jev configuration error' }],
  [path.join(root, 'electron/services/todoJevService'), { requestTodoJev: async (config, state, questions) => {
    assert.equal(config.apiKey, config.backend === 'laya' ? '' : 'synthetic-no-network-key')
    jevRequests.push({ state: clone(state), questions: clone(questions) })
    return jevResponder ? jevResponder(state, questions, jevRequests.length) : jevResponse(questions)
  } }],
  [path.join(root, 'electron/services/ai/providers/catalog'), { getProviderDefinition: () => ({}), normalizeProviderId: (id) => id }],
  [path.join(root, 'src/shared/aiProviderReadiness'), { evaluateAIProviderReadiness: () => ({ ready: providerConfigured }) }],
])
const loaded = new Map()
function load(filename) {
  const absolute = path.resolve(root, filename)
  if (loaded.has(absolute)) return loaded.get(absolute)
  const code = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  const module = { exports: {} }
  const localRequire = (id) => {
    const key = id.startsWith('.') ? path.resolve(path.dirname(absolute), id) : id
    if (overrides.has(key)) return overrides.get(key)
    if (id.startsWith('.')) return load(`${key.replace(/\.ts$/, '')}.ts`)
    if (['crypto', 'child_process', 'util', 'fs/promises', 'path'].includes(id)) return require(id)
    throw new Error(`Unexpected module: ${id}`)
  }
  vm.runInNewContext(code, { module, exports: module.exports, require: localRequire, console, Buffer, TextEncoder, URL, process, setInterval, clearInterval, setTimeout }, { filename: absolute })
  loaded.set(absolute, module.exports)
  return module.exports
}
function resetStore() {
  data = {
    todoItems: [], todoTombstones: [], todoRejectedSourceHashes: [], todoMailAccounts: [],
    todoSettings: { personalContext: '关注项目交付', learningEnabled: true, connectors: [] },
    todoScanState: { lastScanAt: 0, lastSuccessfulScanAt: 0, lastAutoScanDay: '', processedFingerprints: [], analyzedMessages: 0, extractedTodos: 0, lastError: '' },
    todoSyncConfig: { deviceId: 'test-desktop', encryptedPassword: 'leave-this-alone' },
  }
  dirty = 0
  syncing = false
  generationCount = 0
  generationFailure = false
  generationResponder = null
  providerConfigured = true
  providerResolutionCount = 0
  jevEnabled = false
  jevBackend = 'jev'
  jevRequests = []
  jevResponder = null
  notificationCount = 0
  chatMessages = []
  dropNextConfigWrite = null
}
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const makeMessages = (count, text = id => `请确认项目合同 ${id}`) => Array.from({ length: count }, (_, index) => ({
  serverId: index + 1, localId: index + 1, createTime: Math.floor(Date.now() / 1000), sortSeq: index + 1,
  parsedContent: typeof text === 'function' ? text(index + 1) : text, isSend: 0,
}))
const fingerprint = (message) => createHash('sha256').update(`wechat:test-room:${message.serverId}:${message.localId}:${message.createTime}:${message.sortSeq}`).digest('hex')
const makeItem = (id, sourceType = 'wechat') => ({
  id, title: '确认交付', details: '', dueAt: null, priority: 'medium', status: 'pending',
  sourceType, sourceRef: `${sourceType}:${id}`, sourceLabel: '项目组', sourcePreview: '', confidence: 1,
  createdAt: Date.now(), updatedAt: Date.now(),
  insight: { kind: 'action', score: 60, baseScore: 60, adjustment: 0, reason: '', topics: ['交付'] },
})

async function main() {
  resetStore()
  const { TodoService } = load('electron/services/todoService.ts')
  const service = new TodoService()
  data.todoItems = [makeItem('automatic'), makeItem('manual', 'manual')]
  assert.match(service.getState().profile.summary, /关注项目交付/)
  assert.equal(service.getState().profile.roles.length, 0, 'content cannot prove occupation')
  service.recordFeedback('automatic', 'useful')
  assert.equal(service.getState().profile.usefulCount, 1)
  service.recordFeedback('automatic', 'useless')
  assert.equal(data.todoItems[0].feedback, 'not-useful', 'UI vote must use portable storage format')
  assert.equal(data.todoItems[0].status, 'dismissed')
  assert.equal(service.getState().profile.usefulCount, 0, 'changing a vote replaces old evidence')
  assert.equal(service.getState().profile.uselessCount, 1)
  service.recordFeedback('automatic', null)
  assert.equal(data.todoItems[0].status, 'pending', 'withdrawing negative feedback restores state')
  assert.equal(service.getState().profile.uselessCount, 0)
  assert.throws(() => service.recordFeedback('automatic', 'invalid'), /无效/)
  assert.throws(() => service.recordFeedback('missing', 'useful'), /不存在/)
  service.recordFeedback('automatic', 'useful')
  data.todoSettings.learningEnabled = false
  assert.match(service.getState().profile.summary, /已暂停/)
  assert.equal(service.getState().profile.usefulCount, 1, 'pausing learning must not erase votes')
  data.todoTombstones = [{ id: 'older-deletion', deletedAt: 1, deviceId: 'phone' }]
  data.todoRejectedSourceHashes = ['old-rejection']
  data.todoScanState.processedFingerprints = ['old-fingerprint']
  const originalSettings = clone(data.todoSettings)
  syncing = true
  assert.throws(() => service.resetScan(), /同步进行中/)
  syncing = false
  service.scanPromise = Promise.resolve({ success: true })
  assert.throws(() => service.resetScan(), /扫描进行中/)
  service.scanPromise = null
  assert.equal(service.resetScan(), 1)
  assert.deepEqual(data.todoItems.map((item) => item.id), ['manual'])
  assert.deepEqual(data.todoTombstones.map((item) => item.id), ['older-deletion', 'automatic'], 'sync must not resurrect deleted automatic items')
  assert.deepEqual(data.todoRejectedSourceHashes, [])
  assert.deepEqual(data.todoScanState.processedFingerprints, [])
  assert.deepEqual(data.todoSettings, originalSettings)
  assert.equal(data.todoSyncConfig.encryptedPassword, 'leave-this-alone')
  assert.ok(dirty > 0)

  resetStore()
  const nowSeconds = Math.floor(Date.now() / 1000)
  chatMessages = [1, 2].map((id) => ({ serverId: id, localId: id, createTime: nowSeconds, sortSeq: id, parsedContent: `请确认合同 ${id}`, isSend: 0 }))
  data.todoScanState.processedFingerprints = [fingerprint(chatMessages[0])]
  const scanned = await service.scanWechat(true)
  assert.equal(scanned.success, true)
  assert.equal(scanned.addedTodos, 1)
  assert.equal(generationCount, 1)
  assert.equal(data.todoScanState.lastCacheHits, 1)
  assert.equal(data.todoScanState.lastSentMessages, 1)
  assert.equal(data.todoScanState.lastInputTokens, 120)
  assert.equal(data.todoScanState.lastOutputTokens, 24)
  assert.equal(data.todoScanState.lastEstimatedCostUsd, undefined, 'unknown billing is not a fabricated free estimate')
  await service.scanWechat(true)
  assert.equal(generationCount, 1, 'successful message fingerprints must skip a second model call')
  assert.equal(data.todoScanState.lastCacheHits, 2)
  assert.equal(data.todoScanState.lastSentMessages, 0)
  service.resetScan()
  generationFailure = true
  const failed = await service.scanWechat(true)
  assert.equal(failed.success, false)
  assert.match(failed.error, /provider failure/)
  assert.equal(data.todoScanState.lastSentMessages, 2)
  assert.equal(data.todoScanState.processedFingerprints.length, 0, 'failed model calls must remain retryable')

  const { parseGeneratedTodoResponse, recoverGeneratedEvidenceQuote, checkGeneratedTodoItems } = load('src/shared/todoGeneratedEvidence.ts')
  const originalQuote = '请核对“ＡＢＣ”，\n  金额：３００元。'
  const equivalentQuote = '请核对"ABC", 金额:300元。'
  assert.equal(recoverGeneratedEvidenceQuote(originalQuote, equivalentQuote), originalQuote, 'presentation differences must map back to a continuous, verbatim original span')
  assert.equal(recoverGeneratedEvidenceQuote(`🙂前文 ${originalQuote} 后文`, `“${equivalentQuote}”`), originalQuote, 'UTF-16 offsets and optional quote wrappers must preserve the original evidence')
  assert.equal(recoverGeneratedEvidenceQuote('请核\u200b对合同。', '请核对合同。'), '请核\u200b对合同。')
  for (const fabricated of ['请确认合同。', '请核对ABC，金额300元。', '请核对…300元。', '金额:3000元。']) {
    assert.equal(recoverGeneratedEvidenceQuote(originalQuote, fabricated), null, 'rewritten, stitched, or materially changed quotations are not evidence')
  }
  assert.equal(recoverGeneratedEvidenceQuote('ﬀ', 'f'), null, 'a partial Unicode expansion must not create evidence')
  assert.equal(recoverGeneratedEvidenceQuote('甲'.repeat(401), '甲'.repeat(401)), null, 'oversized evidence becomes reviewable, not silently truncated into a claim')
  assert.equal(recoverGeneratedEvidenceQuote('确认合同', null), null)

  const syntheticSources = [{ key: 'source-a', text: '明天下午3点请确认项目合同。' }, { key: 'source-b', text: '请核对项目预算。' }]
  const validGenerated = { messageKey: 'source-a', title: '确认合同', kind: 'action', evidenceQuote: syntheticSources[0].text }
  for (const wrapper of [
    JSON.stringify([validGenerated]),
    `\u0060\u0060\u0060json\n${JSON.stringify([validGenerated])}\n\u0060\u0060\u0060`,
    `以下为结果：\n${JSON.stringify({ items: [validGenerated] })}\n分析结束。`,
    JSON.stringify({ todos: [validGenerated] }),
    JSON.stringify({ results: [validGenerated] }),
    JSON.stringify(validGenerated),
  ]) assert.equal(parseGeneratedTodoResponse(wrapper).length, 1, 'common complete JSON response shapes should be readable')
  for (const malformed of ['', 'not-json PRIVATE_RESPONSE_CONTENT', '{"items":[],"todos":[]}', '{"items":"bad","metadata":[]}', '[] []', '{"items":[]} {"items":[]}']) {
    assert.throws(() => parseGeneratedTodoResponse(malformed), error => /保留为可重试/.test(error.message) && !error.message.includes('PRIVATE_RESPONSE_CONTENT'), 'unreadable or ambiguous JSON must remain retryable without logging message content')
  }
  for (const alias of ['messageKey', 'messageId', 'message_key', 'message_id', 'id']) {
    const checked = checkGeneratedTodoItems([{ ...validGenerated, messageKey: null, [alias]: ' source-a ', details: null, dateCandidateId: '', dueAt: 'null' }], syntheticSources)[0]
    assert.equal(checked.message.key, 'source-a')
    assert.equal(checked.raw.details, '')
    assert.equal(checked.raw.dateCandidateId, null)
    assert.equal(checked.raw.dueAt, null)
    assert.equal(checked.raw.evidence, undefined, 'valid extraction evidence must still be created by the date validator')
  }
  for (const badField of [{ title: '' }, { title: null }, { kind: null }, { kind: 'todo' }, { evidenceQuote: '' }, { evidenceQuote: null }, { evidenceQuote: '原消息未出现的截止日期' }]) {
    const checked = checkGeneratedTodoItems([{ ...validGenerated, ...badField, dueAt: '2026-10-01T01:00:00Z' }], syntheticSources)[0]
    assert.equal(checked.raw.kind, 'information')
    assert.equal(checked.raw.dueAt, null)
    assert.equal(checked.raw.evidence.needsReview, true)
    assert.equal(checked.raw.evidence.messageQuote, syntheticSources[0].text)
    assert.ok(checked.raw.title.startsWith('待核对：'))
    assert.equal(checked.raw.details, syntheticSources[0].text)
  }
  for (const badBinding of [
    { messageKey: 'unknown-key' }, { messageKey: null }, { messageKey: 0 },
    { messageKey: 'source-a', messageId: 'source-b' }, { messageKey: '', id: 'generated-item-id' },
  ]) assert.throws(() => checkGeneratedTodoItems([{ ...validGenerated, ...badBinding }], syntheticSources), /编号.*可重试/, 'unknown/conflicting identifiers cannot be guessed from an exact quote')
  assert.throws(() => checkGeneratedTodoItems([null], syntheticSources), /编号.*可重试/)

  // A bad but identifiable extraction must not block another valid result. The
  // bad item preserves only source text, never model-written actions/reminders.
  resetStore()
  chatMessages = makeMessages(3, id => [
    '请于明天下午3点确认“Ａ”项目合同，金额：３００元。',
    '请核对项目预算后再决定签约时间。',
    '项目材料已更新，请核对版本。',
  ][id - 1])
  let expectedDate
  generationResponder = payload => {
    expectedDate = payload[0].dateCandidates.find(candidate => candidate.dueAt)
    assert.ok(expectedDate, 'positive control must have a locally grounded precise time')
    return { text: JSON.stringify({ items: [
      { messageId: payload[0].messageKey, title: '确认项目合同', kind: ' ACTION ', confidence: .98, details: null, evidenceQuote: payload[0].text.normalize('NFKC').replace(/[“”]/g, '"'), dateCandidateId: expectedDate.id, evidence: { engine: 'jev', dateStatus: 'exact', needsReview: false } },
      { message_key: payload[1].messageKey, title: '凭空要求转账', kind: 'action', details: 'PRIVATE_GENERATED_INVENTION', evidenceQuote: '不存在的提醒原文', dueAt: '2026-10-01T01:00:00Z', evidence: { engine: 'jev', dateStatus: 'exact', needsReview: false } },
      { message_id: payload[2].messageKey, title: null, kind: null, evidenceQuote: '', dateCandidateId: '' },
    ] }), totalUsage: { inputTokens: 321, outputTokens: 45 } }
  }
  const recoveredBatch = await service.scanWechat(true)
  assert.equal(recoveredBatch.success, true)
  assert.equal(recoveredBatch.addedTodos, 3)
  assert.equal(data.todoScanState.processedFingerprints.length, 3)
  assert.equal(data.todoScanState.lastInputTokens, 321)
  assert.equal(data.todoScanState.lastOutputTokens, 45)
  const groundedItem = data.todoItems.find(item => item.title === '确认项目合同')
  assert.equal(groundedItem.dueAt, expectedDate.dueAt, 'a valid sibling keeps its locally verified reminder')
  assert.equal(groundedItem.evidence.engine, 'llm', 'provider-supplied evidence is never trusted')
  assert.equal(groundedItem.evidence.messageQuote, chatMessages[0].parsedContent, 'stored evidence is original full-width punctuation, not model-normalized text')
  for (const reviewed of data.todoItems.filter(item => item.id !== groundedItem.id)) {
    assert.equal(reviewed.dueAt, null)
    assert.equal(reviewed.insight.kind, 'information')
    assert.equal(reviewed.evidence.needsReview, true)
    assert.equal(reviewed.evidence.engine, 'llm')
    assert.ok(reviewed.sourcePreview.includes(reviewed.evidence.messageQuote))
    assert.ok(reviewed.title.startsWith('待核对：'))
    assert.ok(!JSON.stringify(reviewed).includes('PRIVATE_GENERATED_INVENTION'))
  }
  await service.scanWechat(true)
  assert.equal(generationCount, 1, 'a successfully recovered batch is checkpointed and not sent repeatedly')

  // A grounded source date proves the timestamp, not the model's uncertain
  // claim that this is actually an obligation belonging to the user.
  for (const confidence of [.05, .79, undefined, null, '0.99', NaN, Infinity, -1, 1.1]) {
    resetStore()
    chatMessages = makeMessages(1, '明天下午3点可能需要核对项目合同，负责人仍待确认。')
    generationResponder = payload => ({ text: JSON.stringify(payload.map(message => ({
      messageKey: message.messageKey, title: '核对项目合同', kind: 'action', evidenceQuote: message.text,
      dateCandidateId: message.dateCandidates.find(candidate => candidate.dueAt).id, confidence,
    }))) })
    const uncertain = await service.scanWechat(true)
    assert.equal(uncertain.success, true)
    assert.equal(data.todoItems.length, 1)
    const saved = data.todoItems[0]
    assert.equal(saved.dueAt, null, `uncertain/invalid LLM confidence ${String(confidence)} cannot schedule a source date automatically`)
    assert.equal(saved.evidence.needsReview, true)
    assert.equal(saved.evidence.dateStatus, 'unconfirmed')
    assert.equal(data.todoScanState.processedFingerprints.length, 1, 'uncertain but identifiable content is saved for review without repeated API costs')
    service.update(saved.id, { dueAt: '2026-10-01T01:00:00.000Z' })
    assert.equal(data.todoItems[0].evidence.needsReview, true, 'choosing a time cannot resolve uncertainty about the underlying generated task')
  }

  // An unbound sibling still prevents a checkpoint for the entire batch. No
  // source is consumed or attached to invented identifiers, even with a quote.
  for (const unknownId of ['unknown-source', null]) {
    resetStore()
    chatMessages = makeMessages(2)
    generationResponder = payload => ({ text: JSON.stringify(payload.map((message, index) => ({
      messageKey: index ? unknownId : message.messageKey, title: '确认合同', kind: 'action', evidenceQuote: message.text,
    }))) })
    const unbound = await service.scanWechat(true)
    assert.equal(unbound.success, false)
    assert.match(unbound.error, /编号.*可重试/)
    assert.equal(data.todoItems.length, 0)
    assert.equal(data.todoScanState.processedFingerprints.length, 0)
    generationResponder = null
    assert.equal((await service.scanWechat(true)).success, true)
    assert.equal(generationCount, 2)
    assert.equal(data.todoItems.length, 2)
  }

  resetStore()
  jevEnabled = true
  providerConfigured = false
  chatMessages = makeMessages(1, '请于明天下午3点确认项目合同。')
  assert.equal(service.getState().aiConfigured, true, 'Jev has its own configuration; a generic LLM key is unnecessary')
  const jevOnly = await service.scanWechat(true)
  assert.equal(jevOnly.success, true)
  assert.equal(jevOnly.addedTodos, 1)
  assert.equal(jevRequests.length, 1)
  assert.equal(providerResolutionCount, 0, 'Jev scanning must never resolve the generic provider')
  assert.equal(generationCount, 0, 'Jev scanning must never call generateText')
  assert.equal(data.todoScanState.lastDecisionEngine, 'jev')
  assert.equal(data.todoScanState.lastDecisionRequests, 1)
  assert.equal(data.todoScanState.lastInputTokens, 90)
  assert.equal(data.todoScanState.lastOutputTokens, 18)
  assert.equal(data.todoItems[0].evidence.engine, 'jev')
  assert.equal(data.todoItems[0].evidence.dateStatus, 'exact')
  assert.ok(chatMessages[0].parsedContent.includes(data.todoItems[0].evidence.dateQuote))
  assert.ok(data.todoItems[0].dueAt)

  resetStore()
  jevEnabled = true
  jevBackend = 'laya'
  providerConfigured = false
  data.todoSettings.reminderEnabled = true
  data.todoSettings.remindBeforeMinutes = 30
  data.todoSettings.autoScanEnabled = false
  chatMessages = makeMessages(4, id => `请于明天下午3点核对第${id}份项目合同。`)
  const layaChoices = ['action', 'important', 'noise', 'uncertain']
  jevResponder = (_state, questions, call) => jevResponse(questions, () => layaChoices[call - 1])
  assert.equal(jevConfigService.getState().hasApiKey, false, 'Laya positive control does not accidentally provide a key')
  assert.equal(service.getState().aiConfigured, true, 'local Laya needs neither its own key nor generic LLM configuration')
  const layaOnly = await service.scanWechat(true)
  assert.equal(layaOnly.success, true)
  assert.equal(layaOnly.addedTodos, 4, 'all uncalibrated Laya classes, including noise, must be retained for review')
  assert.equal(jevRequests.length, 4, 'Laya sends exactly one message per request')
  jevRequests.forEach((request, index) => {
    assert.equal(typeof request.state, 'string')
    assert.ok(request.state.endsWith(chatMessages[index].parsedContent), 'Laya request preserves the complete corresponding message')
    assert.ok(chatMessages.filter(message => request.state.includes(message.parsedContent)).length === 1, 'one request never mixes separate messages')
    assert.deepEqual(Object.keys(request.questions), ['value'], 'local NLI classifies value only; it cannot select dates')
  })
  assert.equal(providerResolutionCount, 0)
  assert.equal(generationCount, 0)
  assert.equal(data.todoScanState.lastDecisionEngine, 'laya')
  assert.equal(data.todoScanState.lastDecisionRequests, 4)
  assert.equal(data.todoScanState.lastSentMessages, 4)
  assert.equal(data.todoScanState.lastReviewItems, 4)
  assert.equal(data.todoScanState.processedFingerprints.length, 4)
  for (const item of data.todoItems) {
    assert.equal(item.dueAt, null, 'even high-confidence Laya actions cannot automatically schedule reminders')
    assert.equal(item.evidence.engine, 'laya')
    assert.equal(item.evidence.needsReview, true)
    assert.equal(item.evidence.dateStatus, 'unconfirmed')
    assert.ok(item.sourcePreview.includes(item.evidence.dateQuote), 'displayed date candidates remain grounded in the original text')
  }
  await service.tick()
  assert.equal(notificationCount, 0)
  assert.ok(data.todoItems.every(item => item.remindedAt === undefined))
  const manuallyTimedLaya = data.todoItems.find(item => item.insight.kind === 'action')
  service.update(manuallyTimedLaya.id, { dueAt: new Date(Date.now() + 60_000).toISOString() })
  assert.equal(data.todoItems.find(item => item.id === manuallyTimedLaya.id).evidence.needsReview, true)
  await service.tick()
  assert.equal(notificationCount, 1, 'explicitly setting a Laya reminder time works while the separate content-review flag remains')
  assert.ok(data.todoItems.find(item => item.id === manuallyTimedLaya.id).remindedAt)
  await service.scanWechat(true)
  assert.equal(jevRequests.length, 4, 'reviewable local classification is checkpointed without another request')

  resetStore()
  jevEnabled = true
  jevBackend = 'laya'
  providerConfigured = false
  chatMessages = makeMessages(1, `请于明天下午3点核对项目合同。${'以下为完整背景信息。'.repeat(45)}`)
  jevResponder = () => { throw new Error('Long Laya input must stay local without even a mocked provider request') }
  const longLaya = await service.scanWechat(true)
  assert.equal(longLaya.success, true)
  assert.equal(longLaya.addedTodos, 1)
  assert.equal(longLaya.analyzedMessages, 0, 'local-only review must not report a model-analyzed message')
  assert.equal(data.todoScanState.analyzedMessages, 0, 'local-only review must not increment cumulative model analysis')
  assert.equal(jevRequests.length, 0)
  assert.equal(generationCount, 0)
  assert.equal(providerResolutionCount, 0)
  assert.equal(data.todoScanState.lastDecisionEngine, 'laya')
  assert.equal(data.todoScanState.lastSentMessages, 0)
  assert.equal(data.todoScanState.lastDecisionRequests, 0)
  assert.equal(data.todoScanState.lastReviewItems, 1)
  assert.equal(data.todoScanState.lastInputTokens, undefined, 'local review cannot claim paid-model token usage')
  assert.equal(data.todoScanState.processedFingerprints.length, 1)
  assert.equal(data.todoItems[0].sourcePreview, chatMessages[0].parsedContent, 'length-budget fallback preserves original text for review')
  assert.equal(data.todoItems[0].dueAt, null)
  assert.equal(data.todoItems[0].evidence.engine, 'laya')
  assert.equal(data.todoItems[0].evidence.needsReview, true)
  assert.match(data.todoItems[0].insight.reason, /长度预算|未发送/)

  // An unknown choice is a malformed response, unlike the supported
  // "uncertain" choice, which must become a reviewable item.
  for (const invalidQuestion of ['value', 'date']) {
    resetStore()
    jevEnabled = true
    providerConfigured = false
    chatMessages = makeMessages(1, '请于明天下午3点确认项目合同。')
    jevResponder = (_state, questions) => {
      const response = jevResponse(questions)
      response.answers[`m0_${invalidQuestion}`].choice = 'unknown-invented-answer'
      return response
    }
    const invalid = await service.scanWechat(true)
    assert.equal(invalid.success, false, `unknown ${invalidQuestion} choice must fail the batch`)
    assert.match(invalid.error, /无效|选项|判断/)
    assert.equal(data.todoItems.length, 0)
    assert.equal(data.todoScanState.processedFingerprints.length, 0, 'invalid decisions remain retryable')
    assert.equal(data.todoScanState.lastSuccessfulScanAt, 0)
    assert.equal(data.todoScanState.lastSentMessages, 1)
    jevResponder = null
    assert.equal((await service.scanWechat(true)).success, true)
    assert.equal(jevRequests.length, 2, 'the failed message is sent on the next explicit retry')
    assert.equal(data.todoScanState.processedFingerprints.length, 1)
    assert.equal(generationCount, 0)
  }
  resetStore()
  jevEnabled = true
  chatMessages = makeMessages(1, '明天下午3点可能需要你确认合同，尚待确认。')
  jevResponder = (_state, questions) => jevResponse(questions, id => id.endsWith('_value') ? 'uncertain' : 'uncertain')
  assert.equal((await service.scanWechat(true)).success, true)
  assert.equal(data.todoItems.length, 1, 'the valid uncertain choice is preserved for user review')
  assert.equal(data.todoItems[0].evidence.needsReview, true)
  assert.equal(data.todoItems[0].dueAt, null)

  // Only a successfully persisted batch is guaranteed not to be billed again.
  // This simulates a later provider failure, not a disk checkpoint failure.
  resetStore()
  jevEnabled = true
  providerConfigured = false
  chatMessages = makeMessages(13)
  const messageKeys = chatMessages.map(message => fingerprint(message).slice(0, 16))
  jevResponder = (_state, questions, call) => {
    if (call === 2) {
      assert.equal(data.todoItems.length, 6, 'the successful first batch is saved before requesting another')
      assert.deepEqual(data.todoScanState.processedFingerprints, chatMessages.slice(0, 6).map(fingerprint))
      throw new Error('synthetic second-batch failure')
    }
    return jevResponse(questions)
  }
  const partial = await service.scanWechat(true)
  assert.equal(partial.success, false)
  assert.equal(partial.partial, true)
  assert.equal(partial.addedTodos, 6)
  assert.equal(data.todoScanState.lastSuccessfulScanAt, 0, 'partial processing must not advance the successful source cursor')
  assert.equal(data.todoScanState.analyzedMessages, 6)
  assert.equal(data.todoScanState.extractedTodos, 6)
  assert.equal(data.todoScanState.lastSentMessages, 12, 'usage includes messages sent in the failed provider request')
  assert.equal(data.todoScanState.lastDecisionRequests, 2)
  assert.deepEqual(jevRequests.map(request => request.state.messages.length), [6, 6])
  const persistedFirstBatchIds = data.todoItems.map(item => item.id)
  const retryBatch = await service.scanWechat(true)
  assert.equal(retryBatch.success, true)
  assert.equal(retryBatch.addedTodos, 7)
  assert.deepEqual(jevRequests.map(request => request.state.messages.length), [6, 6, 6, 1])
  assert.deepEqual(jevRequests.map(request => request.state.messages.map(message => message.id)), [
    messageKeys.slice(0, 6), messageKeys.slice(6, 12), messageKeys.slice(6, 12), messageKeys.slice(12),
  ], 'retry sends only the failed and unattempted batches, never the already-persisted batch')
  assert.equal(data.todoItems.length, 13)
  assert.equal(new Set(data.todoItems.map(item => item.sourceRef)).size, 13)
  assert.ok(persistedFirstBatchIds.every(id => data.todoItems.some(item => item.id === id)))
  assert.equal(data.todoScanState.processedFingerprints.length, 13)
  assert.equal(data.todoScanState.analyzedMessages, 13)
  assert.equal(data.todoScanState.extractedTodos, 13)
  assert.equal(data.todoScanState.lastCacheHits, 6)
  assert.equal(data.todoScanState.lastSentMessages, 7)
  assert.equal(data.todoScanState.lastDecisionRequests, 2)
  assert.equal(generationCount, 0)

  // Persisting cards must succeed before consuming their source fingerprints.
  // A silent write failure is not a successful checkpoint and may repeat API
  // work on retry; deduplication still preserves any already-saved cards.
  for (const failedWrite of ['todoItems', 'todoScanState']) {
    resetStore()
    jevEnabled = true
    chatMessages = makeMessages(1)
    dropNextConfigWrite = (key, value) => key === failedWrite && (key !== 'todoScanState' || value.processedFingerprints.length > 0)
    const unsavedCheckpoint = await service.scanWechat(true)
    assert.equal(unsavedCheckpoint.success, false, `${failedWrite}: silent storage failure cannot be reported as a completed scan`)
    assert.match(unsavedCheckpoint.error, /保存失败/)
    assert.equal(data.todoScanState.processedFingerprints.length, 0, 'failed checkpoint cannot consume any new source')
    assert.equal(data.todoScanState.lastSuccessfulScanAt, 0)
    assert.equal(data.todoScanState.analyzedMessages, 0, 'only verified checkpoint counts advance')
    assert.equal(data.todoItems.length, failedWrite === 'todoItems' ? 0 : 1)
    assert.equal(unsavedCheckpoint.addedTodos, failedWrite === 'todoItems' ? 0 : 1)
    const savedId = data.todoItems[0]?.id
    assert.equal((await service.scanWechat(true)).success, true)
    assert.equal(jevRequests.length, 2, 'a failed persistence checkpoint may legitimately repeat its API request')
    assert.equal(data.todoItems.length, 1, 'retry cannot duplicate a card whose write succeeded before its fingerprint failed')
    if (savedId) assert.equal(data.todoItems[0].id, savedId)
    assert.equal(data.todoScanState.processedFingerprints.length, 1)
  }

  resetStore()
  jevEnabled = true
  chatMessages = makeMessages(1)
  data.todoItems = [makeItem('existing')]
  const entered = deferred()
  const release = deferred()
  jevResponder = async (_state, questions) => {
    entered.resolve()
    await release.promise
    return jevResponse(questions)
  }
  const concurrentScan = service.scanWechat(true)
  await entered.promise
  service.recordFeedback('existing', 'useless')
  const updatedFeedback = clone(data.todoItems[0])
  // Simulate a phone sync merging a manual item while the decision is in flight.
  const fromPhone = { ...makeItem('phone-added', 'manual'), title: '手机新增的记录' }
  data.todoItems = [...data.todoItems, fromPhone]
  release.resolve()
  assert.equal((await concurrentScan).success, true)
  assert.deepEqual(data.todoItems.find(item => item.id === 'existing'), updatedFeedback, 'checkpoint rereads the latest feedback instead of restoring the pre-request snapshot')
  assert.deepEqual(data.todoItems.find(item => item.id === 'phone-added'), fromPhone, 'checkpoint preserves a concurrently synced item')
  assert.equal(data.todoItems.length, 3)

  for (const engine of ['laya', 'jev', 'llm']) {
    resetStore()
    jevEnabled = engine !== 'llm'
    jevBackend = engine === 'laya' ? 'laya' : 'jev'
    providerConfigured = !jevEnabled
    chatMessages = makeMessages(5, id => ['[图片]', '[表情]', '[语音]', '👍', '...'][id - 1])
    const onlyNoise = await service.scanWechat(true)
    assert.equal(onlyNoise.success, true)
    assert.equal(onlyNoise.addedTodos, 0)
    assert.equal(data.todoItems.length, 0)
    assert.equal(data.todoScanState.lastRuleSkipped, 5)
    assert.equal(data.todoScanState.lastSentMessages, 0)
    assert.equal(data.todoScanState.lastDecisionRequests, 0)
    assert.equal(data.todoScanState.analyzedMessages, 0)
    assert.equal(data.todoScanState.processedFingerprints.length, 5)
    await service.scanWechat(true)
    assert.equal(data.todoScanState.lastCacheHits, 5)
    assert.equal(jevRequests.length, 0, `${engine}: local placeholder noise must never call Jev`)
    assert.equal(generationCount, 0, `${engine}: local placeholder noise must never call generateText`)
  }

  // A legacy provider may return fabricated timestamps/evidence. Neither engine
  // may turn an invalid source date into an automatic reminder.
  for (const engine of ['jev', 'llm']) {
    resetStore()
    jevEnabled = engine === 'jev'
    data.todoSettings.reminderEnabled = true
    data.todoSettings.remindBeforeMinutes = 30
    data.todoSettings.autoScanEnabled = false
    chatMessages = makeMessages(1, '请于2026年2月30日下午3点确认项目合同。')
    generationResponder = payload => ({ text: JSON.stringify(payload.map(message => ({
      messageKey: message.messageKey, title: '确认项目合同', kind: 'action', importance: 90,
      evidenceQuote: message.text, dateCandidateId: 'date:invented', dueAt: new Date().toISOString(),
      evidence: { engine: 'jev', needsReview: false, dateStatus: 'exact', messageQuote: message.text },
    }))) })
    assert.equal((await service.scanWechat(true)).success, true)
    assert.equal(data.todoItems.length, 1)
    assert.equal(data.todoItems[0].dueAt, null, `${engine}: invalid February 30 must never normalize into March or another reminder`)
    if (engine === 'llm') {
      assert.equal(data.todoItems[0].evidence.engine, 'llm', 'unsolicited provider evidence cannot bypass local date verification')
      assert.equal(data.todoItems[0].evidence.needsReview, true)
    }
    await service.tick()
    assert.equal(notificationCount, 0, `${engine}: invalid dates must not emit notifications`)
    assert.equal(data.todoItems[0].remindedAt, undefined, 'invalid dates must not write a reminder marker')
    data.todoItems.push({ ...makeItem('valid-manual-reminder', 'manual'), dueAt: new Date(Date.now() + 60_000).toISOString() })
    await service.tick()
    assert.equal(notificationCount, 1, 'positive control: a valid manual deadline still triggers the mocked reminder path')
    assert.ok(data.todoItems.find(item => item.id === 'valid-manual-reminder').remindedAt)
    assert.equal(data.todoItems.find(item => item.id !== 'valid-manual-reminder').remindedAt, undefined)
  }

  // Manually confirming a date must stop attributing that timestamp to the
  // original message, while preserving any separate content-review concern.
  for (const example of [
    { kind: 'action', confidence: .98, dateStatus: 'date-only', expectedReview: false },
    { kind: 'action', confidence: .98, dateStatus: 'unconfirmed', expectedReview: false },
    { kind: 'information', confidence: .98, dateStatus: 'unconfirmed', expectedReview: true },
    { kind: 'action', confidence: .6, dateStatus: 'unconfirmed', expectedReview: true },
    { kind: 'action', confidence: .98, dateStatus: 'none', expectedReview: true },
    { engine: 'laya', kind: 'action', confidence: .98, dateStatus: 'unconfirmed', expectedReview: true },
  ]) {
    for (const chosenTime of ['2026-10-01T01:00:00.000Z', null]) {
      resetStore()
      const original = makeItem('manual-date-confirmation')
      original.insight.kind = example.kind
      original.remindedAt = 123
      original.evidence = {
        engine: example.engine || 'jev', messageQuote: '明天需要你确认项目合同。', needsReview: true,
        decisionConfidence: example.confidence, dateStatus: example.dateStatus,
        date: '2026-09-24', dateQuote: '明天',
      }
      data.todoItems = [original]
      service.update(original.id, { dueAt: chosenTime })
      const saved = data.todoItems[0]
      assert.equal(saved.dueAt, chosenTime)
      assert.equal(saved.evidence.dateStatus, 'user-confirmed')
      assert.equal(saved.evidence.messageQuote, original.evidence.messageQuote)
      assert.equal(saved.evidence.date, undefined, 'user time must not retain the model-selected source date')
      assert.equal(saved.evidence.dateQuote, undefined, 'user time must not claim the old source quote as its time evidence')
      assert.equal(saved.evidence.needsReview, example.expectedReview, 'date confirmation resolves date-only review, not unrelated content uncertainty')
      assert.equal(saved.remindedAt, undefined, 'changing or clearing a date permits the appropriate future reminder cycle')
      service.update(original.id, { dueAt: chosenTime === null ? '2026-10-02T01:00:00.000Z' : null })
      assert.equal(data.todoItems[0].evidence.needsReview, example.expectedReview, 'repeated manual edits must not erase a preserved content-review concern')
      const beforeInvalidEdit = clone(data.todoItems[0])
      assert.throws(() => service.update(original.id, { dueAt: 'not-a-date' }), /时间|日期|有效|无效/)
      assert.deepEqual(data.todoItems[0], beforeInvalidEdit, 'invalid manual date input cannot clear or overwrite the saved item')
    }
  }
  resetStore()
  data.todoItems = [makeItem('plain-manual', 'manual')]
  service.update('plain-manual', { dueAt: '2026-10-01T01:00:00.000Z' })
  assert.equal(data.todoItems[0].evidence, undefined, 'manual entries must not gain fabricated model evidence')

  resetStore()
  const eventYear = new Date().getUTCFullYear() + 1
  const seminarText = `Department Seminar Date: September 30, ${eventYear} Time: 9:00 a.m. - 10:30 a.m.`
  const eventStart = new Date(Date.UTC(eventYear, 8, 30, 1)).toISOString()
  const eventEnd = new Date(Date.UTC(eventYear, 8, 30, 2, 30)).toISOString()
  const oldSeminar = { ...makeItem('old-seminar', 'imap'), sourcePreview: seminarText,
    evidence: { engine: 'llm', messageQuote: seminarText, needsReview: false, dateStatus: 'none', timeZone: 'Asia/Shanghai' } }
  data.todoItems = [oldSeminar]
  dropNextConfigWrite = key => key === 'todoItems'
  assert.equal(service.getState().items[0].dueAt, null, 'failed repair persistence cannot show a scheduled reminder')
  assert.equal(dirty, 0)
  const recovered = service.getState().items[0]
  assert.equal(recovered.dueAt, eventStart)
  assert.equal(recovered.endAt, eventEnd)
  assert.equal(data.todoItems[0].dueAt, eventStart)
  assert.equal(dirty, 1)
  service.getState()
  assert.equal(dirty, 1, 'repeated dashboard reads do not repeatedly write or sync')
  assert.equal(generationCount, 0, 'existing cards are upgraded locally with no model tokens')
  assert.equal(jevRequests.length, 0)
  service.update(oldSeminar.id, { dueAt: null })
  assert.equal(service.getState().items[0].dueAt, null, 'explicitly cleared dates stay cleared')
  assert.equal(data.todoItems[0].endAt, null, 'manual start edits clear stale event ends')

  resetStore()
  data.todoSettings.connectors = [{ id: 'wechat', type: 'wechat', enabled: true }]
  chatMessages = makeMessages(1, seminarText)
  generationResponder = payload => ({ text: JSON.stringify(payload.map(message => ({
    messageKey: message.messageKey, title: 'Attend Department Seminar', kind: 'action', confidence: 1,
    evidenceQuote: message.text, dateCandidateId: null, endAt: '2099-01-01T00:00:00Z',
  }))) })
  const seminarScan = await service.scanWechat(true)
  assert.equal(seminarScan.success, true)
  const savedSeminar = data.todoItems[0]
  assert.equal(savedSeminar.evidence.dateStatus, 'exact')
  assert.equal(Date.parse(savedSeminar.endAt) - Date.parse(savedSeminar.dueAt), 90 * 60_000, 'new scan carries the original duration, never the generated endAt')
  assert.equal(savedSeminar.sourceCreatedAt, chatMessages[0].createTime)
  assert.ok(savedSeminar.evidence.timeZone, 'unambiguous source zone is retained for later display and recovery')

  overrides.set(path.join(root, 'electron/services/todoService'), { todoService: { start() {}, resetScan: () => service.resetScan(), recordFeedback: (id, vote) => service.recordFeedback(id, vote) } })
  load('electron/main/ipc/todoHandlers.ts').registerTodoHandlers({ getLogService: () => null })
  const failedFeedback = handlers.get('todo:recordFeedback')(null, 'missing', 'useful')
  assert.equal(failedFeedback.success, false, 'IPC must report actual service errors')
  assert.match(failedFeedback.error, /不存在/)
  assert.equal(handlers.get('todo:resetScan')().success, true)
  console.log('todo service contracts passed: conservative LLM recovery and identity/evidence checks, keyless Laya/budgets/review, Jev isolation, batches/checkpoints/retry, concurrent feedback, grounded/manual reminders, reset and IPC')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
