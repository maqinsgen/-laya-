// Pure synthetic fixtures. No account configuration, messages, APIs or clocks.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')
const cache = new Map()
const allowed = new Set(['todoEventQuote.ts', 'todoDateEvidence.ts', 'todoGeneratedEvidence.ts'])
function load(filename) {
  filename = path.resolve(root, filename)
  assert.ok(filename.startsWith(path.join(root, 'src/shared') + path.sep) && allowed.has(path.basename(filename)))
  if (cache.has(filename)) return cache.get(filename).exports
  const module = { exports: {} }
  cache.set(filename, module)
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require: id => {
      assert.ok(id.startsWith('.'), 'no external runtime, network or user-data dependency')
      return load(path.resolve(path.dirname(filename), `${id}.ts`))
    },
  }, { filename })
  return module.exports
}
const { selectVerifiedEventQuote: select } = load('src/shared/todoEventQuote.ts')
const { collectTodoDateCandidates: collect } = load('src/shared/todoDateEvidence.ts')
const event = 'Example University Research Seminar Date: September 30, 2026 (Wednesday) Time: 9:00 a.m. - 10:30 a.m.'
const header = 'From: Department <notice@example.invalid> Sent: September 23, 2026 11:18 AM PST To: Students <group@example.invalid> Subject: Example University Research Seminar '
const tests = []
const test = (name, run) => tests.push({ name, run })
function accepted(source, quote = event) {
  const result = select(source, quote)
  assert.ok(result, 'expected a verified event span')
  assert.ok(source.includes(result), 'only a continuous original source span is returned')
  const dates = collect(result, 946684800, 'Asia/Shanghai')
  assert.equal(dates.length, 1)
  assert.equal(dates[0].dueAt, '2026-09-30T01:00:00.000Z')
  assert.equal(dates[0].endAt, '2026-09-30T02:30:00.000Z')
  return result
}
test('plain structured lecture and flattened Outlook envelope', () => {
  accepted(event)
  accepted(`${header}${event} Zoom: https://example.invalid/j/123456`)
})
test('multiline and CRLF envelopes preserve original text', () => {
  const multiline = event.replace(' Date:', '\r\nDate:').replace(' Time:', '\r\nTime:')
  accepted(`${header.replace(' Sent:', '\r\nSent:').replace(' To:', '\r\nTo:').replace(' Subject:', '\r\nSubject:')}\r\n\r\n${multiline}\r\nVenue: Room A`, multiline)
})
test('Gmail header order uses Date before Subject and To', () => {
  accepted(`From: notice@example.invalid Date: September 23, 2026 11:18 AM GMT Subject: Example University Research Seminar To: group@example.invalid ${event}`)
})
test('flattened From Sent Subject group supports a hidden To field', () => {
  accepted(`主题：Example University Research Seminar 发件人：office@example.invalid From: office@example.invalid Sent: September 23, 2026 11:18 AM PST Subject: Example University Research Seminar ${event} Zoom: https://example.invalid/j/123456`)
})
test('consecutive academic year Term and Semester headings are not event dates', () => {
  for (const year of ['2026-27 Term 1', '2026-2027 Semester 1', '1999-00 Term 1']) {
    accepted(`主题：${year} Regular Example University Research Seminar Series - 1 ${header.replace('Subject: Example University Research Seminar', `Subject: ${year} Regular Example University Research Seminar Series - 1`)}${event} Zoom: https://example.invalid/j/123456`)
  }
  for (const heading of ['2026-27 meeting', '2026-09 Term 1', '2026-2025 Semester 1']) {
    assert.equal(select(`${heading} ${header}${event}`, event), null)
  }
})
test('complete forward year ranges in a speaker biography are not event dates', () => {
  for (const years of ['2017-2022', '2017–2022', '2017—2022', '2017 - 2022', '2022-2022']) {
    accepted(`${header}${event} Venue: Room A Speaker biography: Research fellow (${years}).`, event)
  }
  for (const years of ['2026-09', '2022-2017', '2017-20220', '2017-2022-09', '12017-2022']) {
    assert.equal(select(`${header}${event} Venue: Room A Speaker biography: ${years}.`, event), null)
  }
})
test('presentation-only quote normalization maps back to source', () => {
  const source = event.replace(' Time:', '\nTime:').replace('Department', 'Ｄｅｐａｒｔｍｅｎｔ')
  accepted(source, event)
})
test('cancel and changed-event instructions outside quote veto scheduling', () => {
  for (const warning of ['This seminar is cancelled.', 'This has been postponed.', 'Cancellation notice.', '已取消，请勿参加。', 'Rescheduled to another day.', 'Recording of the lecture.']) {
    assert.equal(select(`${warning} ${header}${event}`, event), null)
    assert.equal(select(`${header}${event} ${warning}`, event), null)
  }
})
test('repeated exact or normalized source quote is ambiguous', () => {
  assert.equal(select(`${event} Venue: A ${event}`, event), null)
  assert.equal(select(`${event.replace(' Time:', '\nTime:')} Venue: A ${event}`, event), null)
})
test('fabricated, stitched and reordered quotes are rejected', () => {
  assert.equal(select(event, event.replace('9:00', '8:00')), null)
  assert.equal(select(event.replace(' Time:', ' Intervening content Time:'), event), null)
  assert.equal(select(event, 'Time: 9:00 a.m. Date: September 30, 2026 Example University Research Seminar'), null)
  assert.equal(select(event, null), null)
})
test('Date and Time fields plus an explicit full year are required', () => {
  for (const text of [event.replace('Date:', ''), event.replace('Time:', ''), event.replace(', 2026', ''), event.replace('September 30, 2026', 'September 30') + ' UTC+0800', event.replace('September 30', 'September 31')]) {
    assert.equal(select(text, text), null)
  }
})
test('tail completion preserves a range that extends past the quote', () => {
  const quote = event.slice(0, event.indexOf(' -'))
  accepted(`${event} Venue: Room A`, quote)
})
test('a dangling time range cannot become a definite single start', () => {
  const quote = event.slice(0, event.indexOf(' -'))
  assert.equal(select(`${quote} - Venue: Room A`, quote), null)
  assert.equal(select(`${quote} to TBD Venue: Room A`, quote), null)
})
test('tail completion cannot discard a trailing unknown timezone', () => {
  assert.equal(select(`${event} XYZ Venue: Room A`, event), null)
  assert.equal(select(`${event} CST Venue: Room A`, event), null)
  assert.equal(select(`${event} Timezone: Atlantis/Unknown Venue: Room A`, event), null)
})
test('tail completion includes explicit offset and adjacent labelled timezone', () => {
  assert.match(accepted(`${event} UTC+08:00 Venue: Room A`, event), /UTC\+08:00/)
  assert.match(accepted(`${event}\nTimezone: Asia/Shanghai\nVenue: Room A`, event), /Timezone: Asia\/Shanghai/)
})
test('zone outside selected event cannot be silently ignored', () => {
  for (const suffix of ['Venue: A Timezone: America/New_York', 'Venue: A All times are UTC.', 'Venue: A Times use CST.']) {
    assert.equal(select(`${event} ${suffix}`, event), null)
  }
})
test('other body dates and orphan clocks veto quote selection', () => {
  for (const extra of ['Registration deadline September 28, 2026.', 'Another lecture tomorrow.', 'Another session 14:00.', 'Invalid alternative October 32, 2026.']) {
    assert.equal(select(`${header}${extra} ${event} Venue: A`, event), null, `prefix: ${extra}`)
    assert.equal(select(`${header}${event} Venue: A ${extra}`, event), null, `suffix: ${extra}`)
  }
})
test('an ungrouped mail-like date is not ignored', () => {
  for (const prefix of ['Date: September 23, 2026 11:18 AM ', 'From: notice@example.invalid Date: September 23, 2026 Subject: Seminar ', 'From: sender To: reader Subject: Seminar Date: September 23, 2026 Time: 11:18 ']) {
    assert.equal(select(`${prefix}${event}`, event), null)
  }
})
test('a body date inside a claimed envelope span is not masked', () => {
  assert.equal(select(`From: notice@example.invalid Sent: September 23, 2026 11:18 AM. Another event October 2, 2026 09:00. Subject: Example University Research Seminar ${event}`, event), null)
})
test('multiple structured events inside quote are rejected', () => {
  const multiple = `${event} Venue: A Seminar Date: October 1, 2026 Time: 09:00`
  assert.equal(select(multiple, multiple), null)
})
test('department abbreviation does not masquerade as timezone', () => {
  accepted(`Example University CSE Office ${header}${event} Zoom: https://example.invalid/j/123456`)
})
let passed = 0
// Keep fixtures and failures local: no source message or credential is logged.
for (const entry of tests) {
  try { entry.run(); passed++; process.stdout.write(`ok ${passed} - ${entry.name}\n`) }
  catch (error) { process.stderr.write(`FAIL - ${entry.name}\n${error.stack}\n`); process.exitCode = 1; break }
}
if (!process.exitCode) process.stdout.write(`${passed} synthetic event-quote groups passed\n`)
