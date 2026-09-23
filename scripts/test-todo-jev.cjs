// Run: node scripts/test-todo-jev.cjs
// Load the real TypeScript modules in an isolated VM. fetch and timers are always
// injected mocks: these tests cannot read account data or make network requests.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
const loaded = new Map()
const timers = new Map()
let nextTimer = 0
let fetchCalls = []
let mockFetch = async () => { throw new Error('No mocked response configured; network is forbidden') }
const fixtureKey = 'jev-test-only-key-do-not-disclose'
const privateText = 'SYNTHETIC_PRIVATE_MESSAGE_DO_NOT_DISCLOSE'
function load(relative) {
  const filename = path.resolve(root, relative)
  assert.ok(filename.startsWith(root + path.sep), 'only load this project')
  if (loaded.has(filename)) return loaded.get(filename)
  const module = { exports: {} }
  loaded.set(filename, module.exports)
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText
  vm.runInNewContext(code, {
    module, exports: module.exports, Buffer, URL, Error, AbortController, TextEncoder,
    require: id => {
      if (!id.startsWith('.')) throw new Error(`Unexpected runtime dependency: ${id}`)
      return load(path.resolve(path.dirname(filename), id.replace(/\.ts$/, '') + '.ts'))
    },
    fetch: async (url, init) => { fetchCalls.push({ url, init }); return mockFetch(url, init) },
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id },
    clearTimeout: id => timers.delete(id),
  }, { filename })
  return module.exports
}
const { buildTodoDecisionRequest, readJevChoice, interpretTodoDecisions, isLocalTodoNoise, validateGeneratedTodoDate, buildLayaDecisionRequest, interpretLayaDecisions, TODO_LAYA_MESSAGE_MAX_BYTES, TODO_LAYA_STATE_MAX_BYTES } = load('src/shared/todoDecision.ts')
const { requestTodoJev, testTodoJevConnection } = load('electron/services/todoJevService.ts')
const { recoverTodoSourceTime } = load('src/shared/todoReminder.ts')
const plain = value => JSON.parse(JSON.stringify(value))
const settings = { personalContext: '我关注项目交付与研究', learningEnabled: true, autoScanEnabled: false, scanHour: 9, reminderEnabled: true, remindBeforeMinutes: 30, wallpaperEnabled: false, connectors: [] }
const config = { endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', apiKey: fixtureKey }
const timeZone = 'Asia/Shanghai'
const sentAt = Date.parse('2026-09-23T10:00:00+08:00') / 1000
const message = (text, patch = {}) => ({ key: 'fixture-message-1', text, createTime: sentAt, sourceLabel: '测试项目组', direction: 'incoming', senderLabel: '测试联系人', ...patch })
const prepare = (...messages) => buildTodoDecisionRequest(messages, settings, [], timeZone)
const choice = (selected, allowed, confidence = .99) => ({ type: 'choice', choice: selected, confidence, probabilities: Object.fromEntries(allowed.map(id => [id, id === selected ? 1 : 0])) })
function answersFor(request, value = 'action', date = 'none', confidence = .99) {
  return Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, choice(id.endsWith('_value') ? value : date, Object.keys(question.criteria), confidence)]))
}
const jsonResponse = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
const protocolQuestion = { selected: { type: 'choice', instructions: 'Read state.message.', criteria: { yes: 'Yes.', no: 'No.' } } }
const goodResponse = () => ({ model: 'jev-1.13.0', answers: { selected: choice('yes', ['yes', 'no']) }, usage: { input_tokens: 123, output_tokens: 4 } })
const tests = []
const test = (name, run) => tests.push({ name, run })
const safeError = error => {
  assert.equal(error.message.includes(fixtureKey), false, 'never expose the API key')
  assert.equal(error.message.includes(privateText), false, 'never expose provider/user content')
  return true
}

test('strict choice schema accepts valid boundary confidences', () => {
  for (const confidence of [0, .8, 1]) assert.deepEqual(plain(readJevChoice(choice('yes', ['yes', 'no'], confidence), ['yes', 'no'])), { choice: 'yes', confidence })
})
test('strict choice schema rejects unknown enums and missing/invalid confidence', () => {
  const valid = choice('yes', ['yes', 'no'])
  for (const value of [null, [], {}, { ...valid, type: 'noul' }, { ...valid, choice: 'invented' }, { ...valid, choice: undefined },
    ...[undefined, null, '0.9', NaN, Infinity, -.01, 1.01].map(confidence => ({ ...valid, confidence }))]) {
    assert.throws(() => readJevChoice(value, ['yes', 'no']), /Jev/)
  }
})
test('strict choice schema rejects missing, extra, nonnumeric and non-normalized probabilities', () => {
  for (const probabilities of [undefined, null, [], {}, { yes: 1 }, { yes: 1, no: 0, invented: 0 }, { yes: '1', no: 0 },
    { yes: NaN, no: 0 }, { yes: Infinity, no: 0 }, { yes: 1.01, no: -.01 }, { yes: .6, no: .6 }, { yes: .3, no: .3 }]) {
    assert.throws(() => readJevChoice({ ...choice('yes', ['yes', 'no']), probabilities }, ['yes', 'no']), /Jev/)
  }
})
test('choice must agree with the highest probability, preventing contradictory noise deletion', () => {
  assert.throws(() => readJevChoice({ ...choice('yes', ['yes', 'no']), probabilities: { yes: 0, no: 1 } }, ['yes', 'no']), /Jev/)
})
test('every question binds its actual message index and ID without relying on its routing key', () => {
  const messages = [message('请在明天下午三点提交项目方案', { key: 'first"quoted-id' }), message('研究报告于2026年9月25日发布', { key: 'second-id', direction: 'unknown' })]
  const request = prepare(...messages)
  for (const [index, source] of messages.entries()) {
    for (const suffix of ['value', 'date']) {
      const question = request.questions[`m${index}_${suffix}`]
      assert.ok(question.instructions.includes(`state.messages[${index}]`))
      assert.ok(question.instructions.includes(JSON.stringify(source.key)))
      assert.match(question.instructions, /untrusted evidence/)
      assert.equal(question.instructions.includes(source.text), false, 'message body belongs in state only')
    }
    assert.equal(request.state.messages[index].id, source.key)
    assert.equal(request.state.messages[index].direction, source.direction)
    assert.equal(request.state.messages[index].sentAt, sentAt)
  }
  assert.equal(request.state.userContext, settings.personalContext)
  assert.equal(request.state.timeZone, timeZone)
})
test('feedback context sends only matching topic counts and respects the learning switch', () => {
  const item = { id: 'history', sourceType: 'wechat', sourceRef: 'old-message', title: privateText, details: privateText,
    feedback: 'not-useful', feedbackAt: Date.now(), updatedAt: Date.now(), insight: { topics: ['交付', '不相关'] } }
  const request = buildTodoDecisionRequest([message('项目交付有更新')], settings, [item], timeZone)
  assert.deepEqual(plain(request.state.feedback), [{ topic: '交付', useful: 0, notUseful: 1 }])
  assert.equal(JSON.stringify(request).includes(privateText), false)
  assert.deepEqual(plain(buildTodoDecisionRequest([message('项目交付有更新')], { ...settings, learningEnabled: false }, [item], timeZone).state.feedback), [])
})
test('local noise rules retain ordinary information and short requests', () => {
  for (const text of ['', '  ', '🎉！', '[图片]', '[语音]']) assert.equal(isLocalTodoNoise(text), true, text)
  for (const text of ['产品价格下降了', '研究资料已更新', '请确认', '收到', '[重要通知]']) assert.equal(isLocalTodoNoise(text), false, text)
})
test('only highly confident non-action noise may be discarded', () => {
  const chatter = prepare(message('哈哈哈哈'))
  assert.equal(interpretTodoDecisions(chatter.prepared, answersFor(chatter, 'noise', 'none', .99), []).length, 0)
  const unsure = interpretTodoDecisions(chatter.prepared, answersFor(chatter, 'noise', 'none', .94), [])[0]
  assert.equal(unsure.evidence.needsReview, true)
  assert.equal(unsure.dueAt, null)
  const obligation = prepare(message('请确认合同'))
  const retained = interpretTodoDecisions(obligation.prepared, answersFor(obligation, 'noise'), [])[0]
  assert.equal(retained.evidence.needsReview, true, 'explicit obligations survive a noise vote')
  assert.match(retained.title, /^待确认：/)
})
test('low confidence and unknown actor preserve source evidence without creating reminders', () => {
  const low = prepare(message('明天下午三点提交项目方案'))
  const answers = answersFor(low, 'urgent_action', low.prepared[0].dates[0].id, .79)
  const result = interpretTodoDecisions(low.prepared, answers, [])[0]
  assert.equal(result.kind, 'information')
  assert.equal(result.importance, 50)
  assert.equal(result.dueAt, null)
  assert.equal(result.evidence.needsReview, true)
  assert.equal(result.evidence.messageQuote, low.prepared[0].message.text)
  const unknownActor = prepare(message('请明天下午三点提交方案', { direction: 'unknown' }))
  const unknown = interpretTodoDecisions(unknownActor.prepared, answersFor(unknownActor, 'action', unknownActor.prepared[0].dates[0].id), [])[0]
  assert.equal(unknown.dueAt, null)
  assert.equal(unknown.evidence.needsReview, true)
})
test('deadline is exclusively the selected local candidate anchored to message time', () => {
  const request = prepare(message('请明天下午三点提交项目方案'))
  const candidate = request.prepared[0].dates[0]
  assert.equal(candidate.dueAt, '2026-09-24T07:00:00.000Z')
  const answers = answersFor(request, 'action', candidate.id)
  answers.m0_date.dueAt = '2099-01-01T00:00:00Z'
  const result = interpretTodoDecisions(request.prepared, answers, [])[0]
  assert.equal(result.dueAt, candidate.dueAt)
  assert.equal(result.evidence.dateQuote, '明天下午三点')
  assert.equal(result.evidence.dateStatus, 'exact')
  assert.equal(result.evidence.needsReview, false)
  assert.throws(() => interpretTodoDecisions(request.prepared, { ...answers, m0_date: { ...answers.m0_date, choice: 'invented-date' } }, []), /Jev/)
})
test('useful information never becomes a reminder even when the date answer selects a candidate', () => {
  const request = prepare(message('研究报告将于明天下午三点发布'))
  for (const value of ['information', 'important_information']) {
    const result = interpretTodoDecisions(request.prepared, answersFor(request, value, request.prepared[0].dates[0].id), [])[0]
    assert.equal(result.kind, 'information')
    assert.equal(result.dueAt, null)
    assert.equal(result.evidence.dateStatus, 'none')
  }
})
test('uncertain, low-confidence and date-only evidence require review without inventing an hour', () => {
  const exact = prepare(message('请明天下午三点提交方案'))
  for (const [selected, confidence] of [['uncertain', .99], [exact.prepared[0].dates[0].id, .89]]) {
    const answers = answersFor(exact, 'action', selected)
    answers.m0_date.confidence = confidence
    const result = interpretTodoDecisions(exact.prepared, answers, [])[0]
    assert.equal(result.dueAt, null)
    assert.equal(result.evidence.needsReview, true)
    assert.equal(result.evidence.dateStatus, 'unconfirmed')
  }
  const dateOnly = prepare(message('请明天提交方案'))
  const result = interpretTodoDecisions(dateOnly.prepared, answersFor(dateOnly, 'action', dateOnly.prepared[0].dates[0].id), [])[0]
  assert.equal(result.dueAt, null)
  assert.equal(result.evidence.dateStatus, 'date-only')
  assert.equal(result.evidence.needsReview, true)
})
test('missing answers reject the entire response and cannot silently complete a partial batch', () => {
  const request = prepare(message('请确认合同'), message('请明天提交方案', { key: 'second' }))
  const answers = answersFor(request)
  for (const missing of Object.keys(request.questions)) {
    const incomplete = { ...answers }
    delete incomplete[missing]
    assert.throws(() => interpretTodoDecisions(request.prepared, incomplete, []), /Jev/)
  }
})
test('legacy generated dates require matching source evidence and may not schedule information', () => {
  const source = message('请明天下午三点提交方案')
  const candidate = prepare(source).prepared[0].dates[0]
  for (const raw of [{ kind: 'action', dueAt: '2099-01-01T00:00:00Z' }, { kind: 'action', dueAt: '2026-09-24T15:00:00' },
    { kind: 'action', dateCandidateId: 'invented' }]) {
    const result = validateGeneratedTodoDate(source, raw, timeZone)
    assert.equal(result.dueAt, null)
    assert.equal(result.evidence.needsReview, true)
  }
  assert.equal(validateGeneratedTodoDate(message('请确认方案'), { kind: 'action', dueAt: candidate.dueAt }, timeZone).dueAt, null)
  assert.equal(validateGeneratedTodoDate(source, { kind: 'action', dueAt: candidate.dueAt, confidence: .99 }, timeZone).dueAt, candidate.dueAt)
  assert.equal(validateGeneratedTodoDate(source, { kind: 'action', dateCandidateId: candidate.id, dueAt: '2099-01-01T00:00:00Z', confidence: .99 }, timeZone).dueAt, candidate.dueAt, 'candidate ID resolves locally, never trusts generated timestamp')
  const information = validateGeneratedTodoDate(source, { kind: 'information', dateCandidateId: candidate.id, dueAt: candidate.dueAt, confidence: .99 }, timeZone)
  assert.equal(information.dueAt, null)
  assert.equal(information.evidence.dateStatus, 'none')
})
test('legacy generated confidence must prove reliable before a date can trigger a reminder', () => {
  const source = message('请明天下午三点提交方案')
  const candidate = prepare(source).prepared[0].dates[0]
  for (const confidence of [0, .05, .79, undefined, null, '0.99', NaN, Infinity, -.1, 1.1]) {
    const result = validateGeneratedTodoDate(source, { kind: 'action', dateCandidateId: candidate.id, confidence }, timeZone)
    assert.equal(result.dueAt, null, `confidence ${String(confidence)} is insufficient to assert an automatic deadline`)
    assert.equal(result.evidence.needsReview, true)
    assert.equal(result.evidence.dateStatus, 'unconfirmed')
    assert.ok(result.evidence.decisionConfidence < .8, 'manual time confirmation must still recognize content uncertainty')
  }
  for (const confidence of [.8, .99, 1]) {
    const result = validateGeneratedTodoDate(source, { kind: 'action', dateCandidateId: candidate.id, confidence }, timeZone)
    assert.equal(result.dueAt, candidate.dueAt)
    assert.equal(result.evidence.needsReview, false)
    assert.equal(result.evidence.decisionConfidence, confidence)
  }
  const noDate = validateGeneratedTodoDate(message('项目进度可能有变化'), { kind: 'information', confidence: .05 }, timeZone)
  assert.equal(noDate.dueAt, null)
  assert.equal(noDate.evidence.needsReview, true, 'low confidence is content uncertainty even without a proposed date')
})
test('explicit seminar date/time is filled locally when generation omitted the date choice', () => {
  const text = 'Example University Research Seminar Date: September 30, 2026 (Wednesday) Time: 9:00 a.m. - 10:30 a.m. Zoom: https://example.com/meeting/synthetic-event'
  const result = validateGeneratedTodoDate(message(text), { kind: 'action', confidence: 1, dateCandidateId: null }, timeZone)
  assert.equal(result.dueAt, '2026-09-30T01:00:00.000Z')
  assert.equal(result.endAt, '2026-09-30T02:30:00.000Z')
  assert.equal(result.evidence.dateStatus, 'exact')
  assert.equal(result.evidence.needsReview, false)
  const forwarded = `Subject: 2026-27 Term 1 Example University Research Seminar From: Example University Office Sent: Wednesday, September 23, 2026 11:18 Subject: 2026-27 Term 1 Example University Research Seminar Series - 1 CSE ${text}`
  const scoped = validateGeneratedTodoDate(message(forwarded), { kind: 'action', confidence: 1, evidenceQuote: text }, timeZone)
  assert.equal(scoped.dueAt, result.dueAt, 'verified event evidence excludes the forwarded mail sending timestamp')
  assert.equal(scoped.endAt, result.endAt)
  assert.equal(validateGeneratedTodoDate(message(forwarded), { kind: 'action', confidence: 1, evidenceQuote: text.slice(text.indexOf('Date:')) }, timeZone).dueAt, result.dueAt, 'event name may precede the source-verified date fields')
  assert.equal(validateGeneratedTodoDate(message(`Cancelled. ${forwarded}`), { kind: 'action', confidence: 1, evidenceQuote: text }, timeZone).dueAt, null)
  for (const raw of [{ kind: 'information', confidence: 1 }, { kind: 'action', confidence: .79 }, { kind: 'action', confidence: 1, dateCandidateId: 'invented' }]) {
    assert.equal(validateGeneratedTodoDate(message(text), raw, timeZone).dueAt, null)
  }
  for (const source of [`Cancelled: ${text}`, `Recording: ${text}`, `${text}\nAnother seminar: October 1, 2026 at 9:00 a.m.`]) {
    assert.equal(validateGeneratedTodoDate(message(source), { kind: 'action', confidence: 1 }, timeZone).dueAt, null)
  }
})
test('old accepted actions gain absolute source times once, preserving manual and uncertain decisions', () => {
  const text = 'Example University Research Seminar Date: September 30, 2026 (Wednesday) Time: 9:00 a.m. - 10:30 a.m.'
  const original = { id: 'old-seminar', title: 'Attend Example University Research Seminar', details: 'generated details are not date evidence',
    sourceType: 'imap', sourcePreview: text, dueAt: null, status: 'pending', confidence: 1,
    insight: { kind: 'action' }, createdAt: Date.parse('2026-09-29T12:00:00Z'), updatedAt: 1,
    evidence: { engine: 'llm', messageQuote: text, needsReview: false, dateStatus: 'none' } }
  const now = Date.parse('2026-09-24T00:00:00Z')
  const result = recoverTodoSourceTime(original, timeZone, now)
  assert.equal(result.dueAt, '2026-09-30T01:00:00.000Z')
  assert.equal(result.endAt, '2026-09-30T02:30:00.000Z')
  assert.equal(result.updatedAt, now)
  const forwarded = `From: Example University Office Sent: September 23, 2026 11:18 Subject: 2026-27 Term 1 Example University Research Seminar ${text}`
  assert.equal(recoverTodoSourceTime({ ...original, sourcePreview: forwarded }, timeZone, now).dueAt, result.dueAt)
  assert.equal(original.dueAt, null, 'recovery must not mutate caller data')
  assert.equal(recoverTodoSourceTime({ ...original, remindedAt: 123 }, timeZone, now).remindedAt, undefined, 'a new time cannot inherit a stale reminder marker')
  assert.equal(recoverTodoSourceTime(result, timeZone, now + 1), result, 'idempotent once stored')
  for (const patch of [{ dueAt: '2026-10-01T01:00:00Z' }, { status: 'completed' }, { status: 'dismissed' },
    { confidence: .79 }, { sourceType: 'manual' }, { insight: { kind: 'information' } },
    { evidence: { ...original.evidence, dateStatus: 'user-confirmed' } },
    { evidence: { ...original.evidence, engine: 'laya' } }, { evidence: { ...original.evidence, needsReview: true } },
    { evidence: { ...original.evidence, engine: 'jev' } },
    { sourcePreview: '请明天下午三点参加讲座' }, { sourcePreview: 'Lecture on September 30 at 9:00 a.m.' },
    { sourceCreatedAt: sentAt, sourcePreview: '会议9月30日09:00 UTC+0800' },
    { sourcePreview: `Cancelled: ${text}` }, { sourcePreview: `Recording: ${text}` },
    { sourcePreview: '', evidence: { ...original.evidence, messageQuote: '' } }]) {
    const item = { ...original, ...patch }
    assert.equal(recoverTodoSourceTime(item, timeZone, now), item, JSON.stringify(patch))
  }
  assert.equal(recoverTodoSourceTime(original, timeZone, Date.parse('2026-10-01T00:00:00Z')), original, 'old events do not gain new reminders')
  const partial = { ...original, dueAt: result.dueAt }
  assert.equal(recoverTodoSourceTime(partial, timeZone, now).endAt, result.endAt, 'preserve existing start and recover exact matching end')
})
test('transport sends the real decisions shape, Bearer auth, bounded timeout and no redirects', async () => {
  const state = { message: 'synthetic fixture only' }
  mockFetch = async (_url, init) => {
    assert.equal(init.method, 'POST')
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers.Authorization, `Bearer ${fixtureKey}`)
    assert.equal(init.headers['Content-Type'], 'application/json')
    assert.deepEqual(JSON.parse(init.body), { model: config.model, state, questions: protocolQuestion })
    assert.equal(init.signal.aborted, false)
    assert.equal([...timers.values()][0].delay, 30_000)
    return jsonResponse(goodResponse())
  }
  const response = await requestTodoJev(config, state, protocolQuestion)
  assert.equal(fetchCalls[0].url, config.endpoint)
  assert.deepEqual(plain(response.usage), { input_tokens: 123, output_tokens: 4 })
})
test('full OpenRouter endpoint is preserved and not rewritten as chat/completions', async () => {
  mockFetch = async () => jsonResponse(goodResponse())
  const custom = { ...config, endpoint: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.13' }
  await requestTodoJev(custom, {}, protocolQuestion)
  assert.equal(fetchCalls[0].url, custom.endpoint)
  assert.equal(JSON.parse(fetchCalls[0].init.body).model, custom.model)
})
test('missing API credentials fail before any network request', async () => {
  await assert.rejects(requestTodoJev({ ...config, apiKey: '' }, {}, protocolQuestion), /API Key/)
  assert.equal(fetchCalls.length, 0)
})
test('HTTP errors never read or expose response content or follow a redirect', async () => {
  for (const status of [302, 401, 422, 429, 500, 529]) {
    mockFetch = async () => ({ ok: false, status, get body() { throw new Error(`${fixtureKey} ${privateText}`) } })
    await assert.rejects(requestTodoJev(config, {}, protocolQuestion), error => { safeError(error); assert.match(error.message, new RegExp(`HTTP ${status}`)); return true })
  }
  assert.equal(fetchCalls.length, 6, 'no implicit retry or redirected request')
  assert.ok(fetchCalls.every(call => call.init.redirect === 'error'))
})
test('transport and JSON errors are sanitized including errors impersonating a safe prefix', async () => {
  for (const failure of [`redirect blocked ${fixtureKey} ${privateText}`, `Jev 请求失败（HTTP 401），${fixtureKey} ${privateText}`]) {
    mockFetch = async () => { throw new Error(failure) }
    await assert.rejects(requestTodoJev(config, {}, protocolQuestion), safeError)
  }
  mockFetch = async () => new Response(`bad JSON ${fixtureKey} ${privateText}`)
  await assert.rejects(requestTodoJev(config, {}, protocolQuestion), safeError)
})
test('empty, malformed, excessive and incomplete success responses are rejected', async () => {
  for (const data of [null, {}, { answers: [] }, { answers: {} }, { answers: { selected: { ...choice('yes', ['yes', 'no']), confidence: null } } }]) {
    mockFetch = async () => jsonResponse(data)
    await assert.rejects(requestTodoJev(config, {}, protocolQuestion), safeError)
  }
  mockFetch = async () => new Response(null, { status: 200 })
  await assert.rejects(requestTodoJev(config, {}, protocolQuestion), /空响应/)
  mockFetch = async () => new Response('x'.repeat(1_048_577))
  await assert.rejects(requestTodoJev(config, {}, protocolQuestion), /响应过大/)
})
test('abort timeout is reported safely and its timer is always cleared', async () => {
  mockFetch = async (_url, init) => {
    [...timers.values()][0].callback()
    assert.equal(init.signal.aborted, true)
    throw new Error(`${fixtureKey} ${privateText}`)
  }
  await assert.rejects(requestTodoJev(config, {}, protocolQuestion), error => { safeError(error); assert.match(error.message, /超时/); return true })
})
test('connectivity test sends only its dedicated synthetic sample and checks the answer', async () => {
  for (const selected of ['blue', 'red']) {
    mockFetch = async (_url, init) => {
      const body = JSON.parse(init.body)
      assert.deepEqual(body.state, { message: 'This is a synthetic connectivity test. The color is blue.' })
      assert.deepEqual(Object.keys(body.questions), ['color'])
      assert.equal(init.body.includes(privateText), false)
      assert.equal(init.body.includes(settings.personalContext), false)
      return jsonResponse({ answers: { color: choice(selected, ['blue', 'red', 'unknown']) } })
    }
    if (selected === 'blue') await testTodoJevConnection(config)
    else await assert.rejects(testTodoJevConnection(config), /连通测试/)
  }
})

const layaConfig = { backend: 'laya', endpoint: 'http://127.0.0.1:8000/v1/systemone', model: 'multilingual', apiKey: '' }
test('local Laya uses multilingual without any Authorization header or inherited cloud key', async () => {
  const request = buildLayaDecisionRequest([message('请明天下午三点提交项目方案')], settings, [], timeZone)
  assert.equal(request.localOnly, false)
  assert.ok(Buffer.byteLength(request.state) <= TODO_LAYA_STATE_MAX_BYTES)
  assert.equal(Object.keys(request.questions).length, 1)
  mockFetch = async (_url, init) => {
    assert.equal(Object.hasOwn(init.headers, 'Authorization'), false)
    const body = JSON.parse(init.body)
    assert.equal(body.model, 'multilingual')
    assert.equal(typeof body.state, 'string')
    assert.ok(body.state.includes('请明天下午三点提交项目方案'))
    return jsonResponse({ answers: { value: choice('action', Object.keys(request.questions.value.criteria)) }, usage: { input_tokens: 100, output_tokens: 0 } })
  }
  const result = await requestTodoJev(layaConfig, request.state, request.questions)
  assert.equal(result.usage.output_tokens, 0)
  const interpreted = interpretLayaDecisions(request.prepared, result.answers, [])[0]
  assert.equal(interpreted.evidence.engine, 'laya')
  assert.equal(interpreted.evidence.needsReview, true)
  assert.equal(interpreted.dueAt, null, 'uncalibrated local scores never enable automatic reminders')
  assert.equal(interpreted.evidence.dateStatus, 'unconfirmed')
  assert.equal(interpreted.evidence.dateQuote, '明天下午三点')
})
test('Laya retains every noise or uncertain result even with confidence 1', () => {
  const request = buildLayaDecisionRequest([message('哈哈哈哈')], settings, [], timeZone)
  for (const selected of Object.keys(request.questions.value.criteria)) {
    const result = interpretLayaDecisions(request.prepared, { value: choice(selected, Object.keys(request.questions.value.criteria), 1) }, [])
    assert.equal(result.length, 1)
    assert.equal(result[0].evidence.needsReview, true)
    assert.equal(result[0].dueAt, null)
  }
})
test('oversized Laya source stays local and is not silently shortened for classification', () => {
  const text = '消息'.repeat(TODO_LAYA_MESSAGE_MAX_BYTES)
  const request = buildLayaDecisionRequest([message(text)], settings, [], timeZone)
  assert.equal(request.localOnly, true)
  assert.equal(request.state, '')
  assert.equal(request.prepared[0].message.text, text)
  const result = interpretLayaDecisions(request.prepared, null, [])[0]
  assert.match(result.reason, /未发送模型/)
  assert.equal(result.evidence.decisionConfidence, undefined)
  assert.equal(result.dueAt, null)
  assert.equal(result.evidence.needsReview, true)
  assert.equal(result.evidence.messageQuote, text.slice(0, 400))
  assert.throws(() => buildLayaDecisionRequest([message('第一条'), message('第二条')], settings, [], timeZone), /一条消息/)
})
test('Laya context is bounded and only includes matching feedback without historical messages', () => {
  const history = [{ sourceType: 'wechat', sourceRef: 'old', title: privateText, details: privateText, feedback: 'useful', feedbackAt: Date.now(), updatedAt: Date.now(), insight: { topics: ['项目', '无关'] } }]
  const request = buildLayaDecisionRequest([message('项目交付计划更新')], { ...settings, personalContext: '我关注项目'.repeat(100) }, history, timeZone)
  assert.equal(request.localOnly, false)
  assert.ok(Buffer.byteLength(request.state) <= TODO_LAYA_STATE_MAX_BYTES)
  assert.equal(request.state.includes(privateText), false)
  assert.equal(request.state.includes('无关'), false)
  assert.ok(request.state.includes('项目:关注'))
  const paused = buildLayaDecisionRequest([message('项目交付计划更新')], { ...settings, learningEnabled: false }, history, timeZone)
  assert.equal(paused.state.includes('项目:关注'), false)
})
test('remote Laya requires HTTPS and its own key; Jev still requires a key on loopback', async () => {
  await assert.rejects(requestTodoJev({ ...layaConfig, endpoint: 'https://laya.example.invalid/v1/systemone' }, '虚构消息', protocolQuestion), /API Key/)
  await assert.rejects(requestTodoJev({ ...layaConfig, endpoint: 'http://192.168.1.2:8000/v1/systemone' }, '虚构消息', protocolQuestion), /HTTPS/)
  await assert.rejects(requestTodoJev({ ...layaConfig, backend: 'jev', model: 'jev-latest' }, '虚构消息', protocolQuestion), /API Key/)
  await assert.rejects(requestTodoJev({ ...layaConfig, model: 'laya' }, '虚构消息', protocolQuestion), /multilingual/)
  assert.equal(fetchCalls.length, 0)
})
test('transport independently rejects oversized or batched Laya input', async () => {
  await assert.rejects(requestTodoJev(layaConfig, 'x'.repeat(TODO_LAYA_STATE_MAX_BYTES + 1), protocolQuestion), /短文本预算/)
  await assert.rejects(requestTodoJev(layaConfig, { messages: ['one', 'two'] }, protocolQuestion), /短文本预算/)
  await assert.rejects(requestTodoJev(layaConfig, '虚构消息', { ...protocolQuestion, another: protocolQuestion.selected }), /短文本预算/)
  assert.equal(fetchCalls.length, 0)
})
test('Laya explicit connectivity check uses a short Chinese fictional sample', async () => {
  mockFetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    assert.equal(body.state, '这张卡片是蓝色的。')
    assert.equal(body.model, 'multilingual')
    assert.equal(Object.hasOwn(init.headers, 'Authorization'), false)
    return jsonResponse({ answers: { color: choice('blue', ['blue', 'red', 'unknown']) } })
  }
  await testTodoJevConnection(layaConfig)
})

async function main() {
  let failures = 0
  for (const entry of tests) {
    fetchCalls = []
    mockFetch = async () => { throw new Error('No mocked response configured; network is forbidden') }
    try {
      await entry.run()
      assert.equal(timers.size, 0, 'all request timers must be cleared')
      console.log(`PASS ${entry.name}`)
    } catch (error) {
      failures++
      console.error(`FAIL ${entry.name}: ${error.message}`)
    } finally { timers.clear() }
  }
  if (failures) throw new Error(`${failures}/${tests.length} Jev tests failed`)
  console.log(`${tests.length} Jev decision/transport tests passed (mock fetch only; zero real requests)`)
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
