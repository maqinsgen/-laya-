import assert from 'node:assert/strict'
import { collectTodoDateCandidates, type TodoDateCandidate } from '../src/shared/todoDateEvidence.ts'

// Synthetic messages only. All expected instants are explicit UTC values so these
// checks are independent of the machine's time zone and the day tests are run.
const shanghai = 'Asia/Shanghai'
const newYork = 'America/New_York'
const sentAt = Date.parse('2026-09-23T02:15:00Z') / 1000 // Wednesday, 10:15 in Shanghai.
let checkedCases = 0

type ExpectedCandidate = {
  date: string
  dueAt: string | null
  endAt?: string | null
  timeZone?: string
  hasExplicitYear?: boolean
  precision: 'date' | 'time'
  evidence?: string[]
}

function checkShape(text: string, candidates: TodoDateCandidate[]): void {
  assert.ok(Array.isArray(candidates), '结果必须是候选数组')
  assert.ok(candidates.length <= 8, '单条消息最多产生 8 个候选')
  const ids = new Set<string>()
  for (const candidate of candidates) {
    assert.equal(typeof candidate.id, 'string')
    assert.ok(candidate.id.length > 0, '候选必须有非空 id')
    assert.ok(!ids.has(candidate.id), '同一消息的候选 id 不可重复')
    ids.add(candidate.id)
    assert.equal(typeof candidate.quote, 'string')
    assert.ok(candidate.quote.trim().length > 0, '候选必须保留原文证据')
    assert.ok(text.includes(candidate.quote), `quote 必须是原文连续子串：${candidate.quote}`)
    assert.match(candidate.date, /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(candidate.precision === 'date' || candidate.precision === 'time')
    if (candidate.precision === 'date') {
      assert.equal(candidate.dueAt, null, '仅有日期时不能补造提醒时刻')
      assert.equal(candidate.endAt ?? null, null, '仅有日期时不能补造结束时刻')
    }
    if (candidate.dueAt !== null) {
      assert.equal(typeof candidate.dueAt, 'string')
      assert.ok(Number.isFinite(Date.parse(candidate.dueAt)), 'dueAt 必须是有效时刻')
      assert.equal(candidate.precision, 'time')
    }
    if (candidate.endAt != null) {
      assert.equal(typeof candidate.endAt, 'string')
      assert.ok(Number.isFinite(Date.parse(candidate.endAt)), 'endAt 必须是有效时刻')
      assert.equal(candidate.precision, 'time')
      assert.ok(candidate.dueAt !== null, '没有唯一开始时刻时不能设置结束时刻')
      assert.ok(Date.parse(candidate.endAt) > Date.parse(candidate.dueAt!), '结束时刻必须严格晚于开始时刻')
    }
    if (candidate.timeZone !== undefined) {
      assert.equal(typeof candidate.timeZone, 'string')
      assert.ok(candidate.timeZone.trim().length > 0, '显式时区字段不可为空')
    }
    if (candidate.hasExplicitYear !== undefined) assert.equal(typeof candidate.hasExplicitYear, 'boolean')
  }
}

function check(
  description: string,
  text: string,
  expected: ExpectedCandidate[],
  messageTimeSeconds = sentAt,
  timeZone = shanghai,
): TodoDateCandidate[] {
  const candidates = collectTodoDateCandidates(text, messageTimeSeconds, timeZone)
  checkShape(text, candidates)
  assert.equal(candidates.length, expected.length, `${description}：候选数量`)
  const unmatched = [...candidates]
  for (const item of expected) {
    const index = unmatched.findIndex((candidate) =>
      candidate.date === item.date && candidate.precision === item.precision &&
      (item.dueAt === null ? candidate.dueAt === null :
        candidate.dueAt !== null && Date.parse(candidate.dueAt) === Date.parse(item.dueAt)))
    assert.notEqual(index, -1, `${description}：缺少 ${JSON.stringify(item)}，实际 ${JSON.stringify(candidates)}`)
    const [matched] = unmatched.splice(index, 1)
    if ('endAt' in item) {
      assert.equal(
        matched.endAt == null ? null : Date.parse(matched.endAt),
        item.endAt == null ? null : Date.parse(item.endAt),
        `${description}：结束时刻`,
      )
    }
    if (item.timeZone !== undefined) assert.equal(matched.timeZone, item.timeZone, `${description}：显式时区`)
    if (item.hasExplicitYear !== undefined) assert.equal(matched.hasExplicitYear, item.hasExplicitYear, `${description}：日期词中的显式年份`)
    for (const evidence of item.evidence ?? []) {
      assert.ok(matched.quote.includes(evidence), `${description}：证据应包含「${evidence}」`)
    }
  }
  checkedCases += 1
  return candidates
}

check('横线年月日没有默认时刻', '请在2026-10-04提交材料。', [
  { date: '2026-10-04', dueAt: null, precision: 'date', evidence: ['2026-10-04'] },
])
check('斜杠年月日和上午时分', '2026/10/04上午9点30分开会。', [
  { date: '2026-10-04', dueAt: '2026-10-04T01:30:00Z', precision: 'time', evidence: ['2026/10/04', '9点30分'] },
])
check('中文年月日和下午时刻', '请于2026年10月4日下午3点开会。', [
  { date: '2026-10-04', dueAt: '2026-10-04T07:00:00Z', precision: 'time', evidence: ['2026年10月4日', '下午3点'] },
])
check('无年份月日和晚上时分', '10月4日晚上8点15分复盘。', [
  { date: '2026-10-04', dueAt: '2026-10-04T12:15:00Z', precision: 'time', evidence: ['10月4日', '晚上8点15分'] },
])
check('日期与二十四小时时分', '2026-10-04 14:05 开会。', [
  { date: '2026-10-04', dueAt: '2026-10-04T06:05:00Z', precision: 'time', evidence: ['2026-10-04', '14:05'] },
])

check('今天仅保留日期', '今天提交材料。', [
  { date: '2026-09-23', dueAt: null, precision: 'date', evidence: ['今天'] },
])
check('明天带上午时间', '明天上午9点开会。', [
  { date: '2026-09-24', dueAt: '2026-09-24T01:00:00Z', precision: 'time', evidence: ['明天', '上午9点'] },
])
check('后天带晚上时间', '后天晚上8点30分复盘。', [
  { date: '2026-09-25', dueAt: '2026-09-25T12:30:00Z', precision: 'time', evidence: ['后天', '晚上8点30分'] },
])
check('中文时分仍须保留完整证据', '明天下午三点半开会。', [
  { date: '2026-09-24', dueAt: '2026-09-24T07:30:00Z', precision: 'time', evidence: ['明天', '下午三点半'] },
])
check('只有下午没有具体时分', '明天下午开会。', [
  { date: '2026-09-24', dueAt: null, precision: 'date', evidence: ['明天'] },
])
check('本周按发送消息所在周计算', '本周一上午10点开会。', [
  { date: '2026-09-21', dueAt: '2026-09-21T02:00:00Z', precision: 'time', evidence: ['本周一', '上午10点'] },
])
check('这周与本周含义一致', '这周五下午2点开会。', [
  { date: '2026-09-25', dueAt: '2026-09-25T06:00:00Z', precision: 'time', evidence: ['这周五', '下午2点'] },
])
check('下周具体星期跨月', '下周三上午9点开会。', [
  { date: '2026-09-30', dueAt: '2026-09-30T01:00:00Z', precision: 'time', evidence: ['下周三', '上午9点'] },
])
check('下周日按周一为一周起点', '下周日晚上8点复盘。', [
  { date: '2026-10-04', dueAt: '2026-10-04T12:00:00Z', precision: 'time', evidence: ['下周日', '晚上8点'] },
])
check('周日发送的下周一是次日', '下周一交报告。', [
  { date: '2026-09-28', dueAt: null, precision: 'date', evidence: ['下周一'] },
], Date.parse('2026-09-27T10:00:00Z') / 1000)

check('上海本地日已经超过 UTC 日', '今天提交；明天复盘。', [
  { date: '2026-09-23', dueAt: null, precision: 'date', evidence: ['今天'] },
  { date: '2026-09-24', dueAt: null, precision: 'date', evidence: ['明天'] },
], Date.parse('2026-09-22T16:30:00Z') / 1000)
check('纽约本地日仍在 UTC 前一天', '明天上午9点开会。', [
  { date: '2026-09-23', dueAt: '2026-09-23T13:00:00Z', precision: 'time', evidence: ['明天', '上午9点'] },
], Date.parse('2026-09-23T02:30:00Z') / 1000, newYork)
check('相对日期可以跨年', '明天交报告。', [
  { date: '2027-01-01', dueAt: null, precision: 'date', evidence: ['明天'] },
], Date.parse('2026-12-31T04:00:00Z') / 1000)
check('无年份月日不得自动滚到下一年', '1月2日交报告。', [
  { date: '2026-01-02', dueAt: null, precision: 'date', evidence: ['1月2日'] },
], Date.parse('2026-12-31T04:00:00Z') / 1000)
check('明确明年才改变月日的年份', '明年1月2日交报告。', [
  { date: '2027-01-02', dueAt: null, precision: 'date', evidence: ['明年1月2日'] },
], Date.parse('2026-12-31T04:00:00Z') / 1000)
check('斜杠月日保留明确的年份修饰', '明年1/2下午3点开会。', [
  { date: '2027-01-02', dueAt: '2027-01-02T07:00:00Z', precision: 'time', evidence: ['明年1/2', '下午3点'] },
])
check('历史消息以发送年份而非扫描年份为准', '明天交报告。', [
  { date: '2024-02-29', dueAt: null, precision: 'date', evidence: ['明天'] },
], Date.parse('2024-02-28T04:00:00Z') / 1000)
check('有效闰日保留', '2028年2月29日交报告。', [
  { date: '2028-02-29', dueAt: null, precision: 'date', evidence: ['2028年2月29日'] },
])
check('本月具体日使用发送年月', '本月25号交报告。', [
  { date: '2026-09-25', dueAt: null, precision: 'date', evidence: ['本月25号'] },
])
check('下月具体日可以跨年', '下月5号上午9点开会。', [
  { date: '2027-01-05', dueAt: '2027-01-05T01:00:00Z', precision: 'time', evidence: ['下月5号', '上午9点'] },
], Date.parse('2026-12-31T04:00:00Z') / 1000)

check('孤立下午时刻属于发送日', '下午3点开会。', [
  { date: '2026-09-23', dueAt: '2026-09-23T07:00:00Z', precision: 'time', evidence: ['下午3点'] },
])
check('孤立二十四小时时分属于发送日', '14:05开会。', [
  { date: '2026-09-23', dueAt: '2026-09-23T06:05:00Z', precision: 'time', evidence: ['14:05'] },
])
check('不同日期各自绑定附近时间', '2026-10-04上午9点开会；2026-10-05下午3点交稿。', [
  { date: '2026-10-04', dueAt: '2026-10-04T01:00:00Z', precision: 'time', evidence: ['2026-10-04', '上午9点'] },
  { date: '2026-10-05', dueAt: '2026-10-05T07:00:00Z', precision: 'time', evidence: ['2026-10-05', '下午3点'] },
])
check('前一个日期不可借用后一个日期的时刻', '明天提交报告。后天下午3点开会。', [
  { date: '2026-09-24', dueAt: null, precision: 'date', evidence: ['明天'] },
  { date: '2026-09-25', dueAt: '2026-09-25T07:00:00Z', precision: 'time', evidence: ['后天', '下午3点'] },
])
check('后一个日期不可借用前一个日期的时刻', '明天下午3点开会。后天提交报告。', [
  { date: '2026-09-24', dueAt: '2026-09-24T07:00:00Z', precision: 'time', evidence: ['明天', '下午3点'] },
  { date: '2026-09-25', dueAt: null, precision: 'date', evidence: ['后天'] },
])
check('存在其他日期时不为隔句时刻另造今天', '明天提交报告。下午3点开会。', [
  { date: '2026-09-24', dueAt: null, precision: 'date', evidence: ['明天'] },
])
check('不把远处时刻跨说明文字拼到日期上', '明天提交报告，负责人和场地尚未确定，下午3点再讨论安排。', [
  { date: '2026-09-24', dueAt: null, precision: 'date', evidence: ['明天'] },
])
check('有日期时保留无效时刻的证据而不设提醒', '2026-10-04 25:00开会。', [
  { date: '2026-10-04', dueAt: null, precision: 'time', evidence: ['2026-10-04', '25:00'] },
])
check('非法下午小时不能转为次日或中午', '明天下午0点开会。', [
  { date: '2026-09-24', dueAt: null, precision: 'time', evidence: ['明天', '下午0点'] },
])
check('非法分钟不能自动归一化到下一小时', '2026-10-04下午3点60分开会。', [
  { date: '2026-10-04', dueAt: null, precision: 'time', evidence: ['2026-10-04', '下午3点60分'] },
])
check('模糊分钟不能默认为整点', '明天下午3点多开会。', [
  { date: '2026-09-24', dueAt: null, precision: 'time', evidence: ['明天', '下午3点'] },
])

// The spring gap and autumn overlap have no unique UTC instant. Keep the
// evidence and local date, but never guess an offset or silently shift the hour.
check('纽约春季不存在的当地时刻', '2026-03-08 02:30开会。', [
  { date: '2026-03-08', dueAt: null, precision: 'time', evidence: ['2026-03-08', '02:30'] },
], sentAt, newYork)
check('纽约秋季重复的当地时刻', '2026-11-01 01:30开会。', [
  { date: '2026-11-01', dueAt: null, precision: 'time', evidence: ['2026-11-01', '01:30'] },
], sentAt, newYork)
check('纽约春季切换前正常时刻', '2026-03-08 01:30开会。', [
  { date: '2026-03-08', dueAt: '2026-03-08T06:30:00Z', precision: 'time', evidence: ['01:30'] },
], sentAt, newYork)
check('纽约春季切换后正常时刻', '2026-03-08 03:30开会。', [
  { date: '2026-03-08', dueAt: '2026-03-08T07:30:00Z', precision: 'time', evidence: ['03:30'] },
], sentAt, newYork)
check('纽约秋季切换后正常时刻', '2026-11-01 02:30开会。', [
  { date: '2026-11-01', dueAt: '2026-11-01T07:30:00Z', precision: 'time', evidence: ['02:30'] },
], sentAt, newYork)

for (const text of [
  '', '收到，谢谢。', '月底交报告。', '改天见面。', '下周开会。',
  '下周下午3点开会。', '周末上午9点聚餐。', '改天下午2点见面。',
  '周五下午3点开会。', '星期五下午3点开会。', '礼拜五下午3点开会。',
  '三天后15:00开会。', '3天后15:00开会。', '2026年15:00开会。', '5月15:00开会。', '2026-09下午3点开会。',
  '3天内15:00开会。', '今明两天15:00开会。', '2026.09.23下午3点开会。',
  '下周3号下午3点开会。', '明年3号下午3点开会。', 'Tomorrow，下午3点开会。',
  '下午3点几分开会。', '下午3点多开会。',
  '2026年2月30日交报告。', '2026-02-29交报告。', '2026/13/01交报告。',
  '2月30日交报告。', '2026-02-30下午3点开会。', '25:00开会。', '下午0点开会。', '下午9点60分开会。',
]) check(`不凭不完整或无效证据猜日期：${text}`, text, [])

for (const text of [undefined, null, 123]) {
  assert.deepEqual(collectTodoDateCandidates(text as unknown as string, sentAt, shanghai), [], '非字符串消息应返回空候选')
  checkedCases += 1
}
for (const timeZone of ['', 'Invalid/Time_Zone', undefined, null]) {
  assert.deepEqual(
    collectTodoDateCandidates('明天下午3点开会。', sentAt, timeZone as unknown as string),
    [],
    `缺失或无效时区必须失败关闭：${String(timeZone)}`,
  )
  checkedCases += 1
}
check('Unix epoch 零是有效发送时间', '今天交报告。', [
  { date: '1970-01-01', dueAt: null, precision: 'date', evidence: ['今天'] },
], 0, 'UTC')
check('有效的负 Unix 时间仍以发送日锚定', '今天交报告。', [
  { date: '1969-12-31', dueAt: null, precision: 'date', evidence: ['今天'] },
], -1, 'UTC')
for (const timestamp of [NaN, Infinity, -Infinity, 1e20, undefined, null]) {
  assert.deepEqual(
    collectTodoDateCandidates('明天下午3点开会。', timestamp as unknown as number, shanghai),
    [],
    `缺失或无效发送时间必须失败关闭：${String(timestamp)}`,
  )
  checkedCases += 1
}

const repeatedText = '明天下午3点开会。明天下午3点交稿。后天提交报告。'
const firstRun = collectTodoDateCandidates(repeatedText, sentAt, shanghai)
checkShape(repeatedText, firstRun)
assert.ok(firstRun.length >= 2, '应保留不同日期的证据')
assert.deepEqual(collectTodoDateCandidates(repeatedText, sentAt, shanghai), firstRun, '相同输入必须产生稳定的候选与 id')
checkedCases += 1

const manyDates = Array.from({ length: 12 }, (_, index) => `2026-10-${String(index + 1).padStart(2, '0')}`)
const longText = manyDates.map((date) => `${date}交报告。`).join('')
const capped = collectTodoDateCandidates(longText, sentAt, shanghai)
checkShape(longText, capped)
assert.equal(capped.length, 8, '超过 8 个有效候选时应截断到上限')
assert.equal(new Set(capped.map((candidate) => candidate.date)).size, 8, '上限内仍须保留不同日期')
assert.ok(capped.every((candidate) => manyDates.includes(candidate.date) && candidate.dueAt === null))
assert.deepEqual(collectTodoDateCandidates(longText, sentAt, shanghai), capped, '截断后的候选与 id 仍须稳定')
checkedCases += 1

const originalTz = process.env.TZ
try {
  process.env.TZ = 'Pacific/Honolulu'
  const hawaiiHost = collectTodoDateCandidates('明天上午9点开会。', sentAt, shanghai)
  process.env.TZ = 'Europe/London'
  const londonHost = collectTodoDateCandidates('明天上午9点开会。', sentAt, shanghai)
  assert.deepEqual(hawaiiHost, londonHost, '运行机器时区不得改变显式消息时区的解析结果')
  assert.equal(hawaiiHost[0]?.date, '2026-09-24')
  assert.equal(Date.parse(hawaiiHost[0]?.dueAt ?? ''), Date.parse('2026-09-24T01:00:00Z'))
  checkedCases += 1
} finally {
  if (originalTz === undefined) delete process.env.TZ
  else process.env.TZ = originalTz
}

// English event announcements use the same evidence contract: the quoted date,
// clock, range and any explicit zone must remain a continuous source substring.
check('英文研讨会通知同时保留开始与结束',
  'Example University Research Seminar Date: September 30, 2026 (Wednesday) Time: 9:00 a.m. - 10:30 a.m. Zoom: https://example.com/meeting/synthetic-event', [
    { date: '2026-09-30', dueAt: '2026-09-30T01:00:00Z', endAt: '2026-09-30T02:30:00Z', precision: 'time',
      evidence: ['September 30, 2026', '(Wednesday)', 'Time:', '9:00 a.m.', '10:30 a.m.'] },
  ])
check('英文 Date 与 Time 字段跨行并保留星期',
  'Example University Research Seminar\nDate: September 30, 2026 (Wednesday)\nTime: 9:00 a.m. - 10:30 a.m.\nVenue: Room 201', [
    { date: '2026-09-30', dueAt: '2026-09-30T01:00:00Z', endAt: '2026-09-30T02:30:00Z', precision: 'time',
      evidence: ['September 30, 2026', '(Wednesday)\nTime:', '10:30 a.m.'] },
  ])
check('英文字段兼容 CRLF 与大写 AM', 'Date: Sep 30, 2026 (Wed)\r\nTime: 9:00 AM', [
  { date: '2026-09-30', dueAt: '2026-09-30T01:00:00Z', endAt: null, precision: 'time', evidence: ['Sep 30, 2026', '(Wed)\r\nTime:', '9:00 AM'] },
])
check('英文日期可直接连接时刻', 'September 30, 2026 09:00 meeting.', [
  { date: '2026-09-30', dueAt: '2026-09-30T01:00:00Z', precision: 'time', evidence: ['September 30, 2026', '09:00'] },
])
check('英文日期没有时间时不补造时刻', 'The deadline is September 30, 2026.', [
  { date: '2026-09-30', dueAt: null, endAt: null, precision: 'date', evidence: ['September 30, 2026'] },
])

const englishMonths = [
  ['January', 'Jan'], ['February', 'Feb'], ['March', 'Mar'], ['April', 'Apr'],
  ['May', 'May'], ['June', 'Jun'], ['July', 'Jul'], ['August', 'Aug'],
  ['September', 'Sep'], ['October', 'Oct'], ['November', 'Nov'], ['December', 'Dec'],
]
for (const [index, [full, short]] of englishMonths.entries()) {
  const month = String(index + 1).padStart(2, '0')
  check(`完整英文月份 ${full}`, `${full} 15, 2027 09:00`, [
    { date: `2027-${month}-15`, dueAt: `2027-${month}-15T01:00:00Z`, precision: 'time', evidence: [`${full} 15, 2027`, '09:00'] },
  ])
  check(`英文月份缩写与日月年顺序 ${short}`, `15 ${short} 2027 09:00`, [
    { date: `2027-${month}-15`, dueAt: `2027-${month}-15T01:00:00Z`, precision: 'time', evidence: [`15 ${short} 2027`, '09:00'] },
  ])
}
check('英文月份大小写不影响解析', 'sEpTeMbEr 30, 2026 09:00', [
  { date: '2026-09-30', dueAt: '2026-09-30T01:00:00Z', precision: 'time', evidence: ['sEpTeMbEr 30, 2026'] },
])
check('Sept 缩写可带句点', 'Date: Sept. 30, 2026 (Wed.)\nTime: 09:00–10:30', [
  { date: '2026-09-30', dueAt: '2026-09-30T01:00:00Z', endAt: '2026-09-30T02:30:00Z', precision: 'time', evidence: ['Sept. 30, 2026', '09:00–10:30'] },
])
check('完整英文日月年顺序', '30 September 2026 9:00 am', [
  { date: '2026-09-30', dueAt: '2026-09-30T01:00:00Z', precision: 'time', evidence: ['30 September 2026', '9:00 am'] },
])
check('英文明确年份优先于发送年', 'September 30, 2028 9:00 am', [
  { date: '2028-09-30', dueAt: '2028-09-30T01:00:00Z', precision: 'time', evidence: ['September 30, 2028'] },
])
check('英文缺年份按发送年且不自动滚到下一年', 'January 2 9:00 am', [
  { date: '2026-01-02', dueAt: '2026-01-02T01:00:00Z', precision: 'time', evidence: ['January 2', '9:00 am'] },
], Date.parse('2026-12-31T04:00:00Z') / 1000)
check('英文日月顺序缺年份也使用发送年', '2 January 09:00', [
  { date: '2026-01-02', dueAt: '2026-01-02T01:00:00Z', precision: 'time', evidence: ['2 January', '09:00'] },
])
check('英文缺年份按发送时区的当地年', 'January 2 09:00', [
  { date: '2026-01-02', dueAt: '2026-01-02T01:00:00Z', precision: 'time', evidence: ['January 2'] },
], Date.parse('2025-12-31T16:30:00Z') / 1000)

for (const [clock, instant] of [
  ['12:00 a.m.', '2026-09-29T16:00:00Z'],
  ['12:00 p.m.', '2026-09-30T04:00:00Z'],
  ['12am', '2026-09-29T16:00:00Z'],
  ['12PM', '2026-09-30T04:00:00Z'],
  ['9 am', '2026-09-30T01:00:00Z'],
  ['3:15 PM', '2026-09-30T07:15:00Z'],
]) check(`英文 AM/PM 时钟 ${clock}`, `September 30, 2026 ${clock}`, [
  { date: '2026-09-30', dueAt: instant, precision: 'time', evidence: ['September 30, 2026', clock] },
])
check('AM 到 PM 的同日范围保留正向结束', 'September 30, 2026 11:30 am - 12:30 pm', [
  { date: '2026-09-30', dueAt: '2026-09-30T03:30:00Z', endAt: '2026-09-30T04:30:00Z', precision: 'time', evidence: ['11:30 am - 12:30 pm'] },
])
check('英文凌晨到上午范围不误加十二小时', 'September 30, 2026 12:00 am - 1:00 am', [
  { date: '2026-09-30', dueAt: '2026-09-29T16:00:00Z', endAt: '2026-09-29T17:00:00Z', precision: 'time', evidence: ['12:00 am - 1:00 am'] },
])
check('英文跨午夜未给结束日期时不猜次日', 'September 30, 2026 11:00 pm - 1:00 am', [
  { date: '2026-09-30', dueAt: '2026-09-30T15:00:00Z', endAt: null, precision: 'time', evidence: ['11:00 pm - 1:00 am'] },
])
check('英文反向范围不能设置结束时刻', 'September 30, 2026 10:30 am - 9:00 am', [
  { date: '2026-09-30', dueAt: '2026-09-30T02:30:00Z', endAt: null, precision: 'time', evidence: ['10:30 am - 9:00 am'] },
])
check('英文零长度范围不能设置结束时刻', 'September 30, 2026 9:00 am - 9:00 am', [
  { date: '2026-09-30', dueAt: '2026-09-30T01:00:00Z', endAt: null, precision: 'time', evidence: ['9:00 am - 9:00 am'] },
])
for (const clock of ['13:00 pm', '0 am', '9:60 am']) {
  check(`英文非法时钟不得归一化 ${clock}`, `September 30, 2026 ${clock}`, [
    { date: '2026-09-30', dueAt: null, endAt: null, precision: 'time', evidence: [clock] },
  ])
}

check('Date 与 Time 之间不可跨越正文',
  'Date: September 30, 2026\nPlease review the agenda before joining.\nTime: 9:00 am', [
    { date: '2026-09-30', dueAt: null, endAt: null, precision: 'date', evidence: ['September 30, 2026'] },
  ])
check('Date 与 Time 之间不可跨越另一字段',
  'Date: September 30, 2026\nSpeaker: Dr. Example\nTime: 9:00 am', [
    { date: '2026-09-30', dueAt: null, endAt: null, precision: 'date', evidence: ['September 30, 2026'] },
  ])
check('多个 Date 连续列出时不能共享一个 Time',
  'Date: September 30, 2026\nDate: October 1, 2026\nTime: 9:00 am', [
    { date: '2026-09-30', dueAt: null, endAt: null, precision: 'date', evidence: ['September 30, 2026'] },
    { date: '2026-10-01', dueAt: null, endAt: null, precision: 'date', evidence: ['October 1, 2026'] },
  ])
check('同一 Date 字段的日期列表不能共用一个 Time',
  'Date: September 30, 2026; October 1, 2026\nTime: 9:00 am', [
    { date: '2026-09-30', dueAt: null, endAt: null, precision: 'date', evidence: ['September 30, 2026'] },
    { date: '2026-10-01', dueAt: null, endAt: null, precision: 'date', evidence: ['October 1, 2026'] },
  ])
check('分开的完整 Date-Time 记录分别绑定',
  'Date: September 30, 2026\nTime: 9:00 AM\n\nDate: October 1, 2026\nTime: 3:00 PM', [
    { date: '2026-09-30', dueAt: '2026-09-30T01:00:00Z', precision: 'time', evidence: ['September 30, 2026\nTime: 9:00 AM'] },
    { date: '2026-10-01', dueAt: '2026-10-01T07:00:00Z', precision: 'time', evidence: ['October 1, 2026\nTime: 3:00 PM'] },
  ])

check('原文 UTC 覆盖调用方上海时区', 'September 30, 2026 09:00 UTC', [
  { date: '2026-09-30', dueAt: '2026-09-30T09:00:00Z', precision: 'time', timeZone: 'UTC', evidence: ['09:00 UTC'] },
])
for (const [zone, instant] of [
  ['UTC+08:00', '2026-09-30T01:00:00Z'],
  ['UTC-04:00', '2026-09-30T13:00:00Z'],
  ['GMT+05:30', '2026-09-30T03:30:00Z'],
  ['GMT+8', '2026-09-30T01:00:00Z'],
  ['UTC+0800', '2026-09-30T01:00:00Z'],
]) check(`原文固定偏移覆盖调用方时区 ${zone}`, `September 30, 2026 09:00 ${zone}`, [
  { date: '2026-09-30', dueAt: instant, precision: 'time', evidence: [`09:00 ${zone}`] },
], sentAt, newYork)
check('原文 IANA 时区覆盖调用方时区', 'September 30, 2026 09:00 Asia/Tokyo', [
  { date: '2026-09-30', dueAt: '2026-09-30T00:00:00Z', precision: 'time', timeZone: 'Asia/Tokyo', evidence: ['09:00 Asia/Tokyo'] },
])
check('独立 Timezone 字段作用于完整时间范围',
  'Date: September 30, 2026\nTime: 9:00 am - 10:30 am\nTimezone: America/New_York', [
    { date: '2026-09-30', dueAt: '2026-09-30T13:00:00Z', endAt: '2026-09-30T14:30:00Z', precision: 'time', timeZone: newYork,
      evidence: ['September 30, 2026', '9:00 am - 10:30 am\nTimezone: America/New_York'] },
  ])
for (const zone of ['CST', 'PST', 'IST']) {
  check(`歧义时区缩写不得使用默认时区猜测 ${zone}`, `September 30, 2026 09:00 ${zone}`, [
    { date: '2026-09-30', dueAt: null, endAt: null, precision: 'time', evidence: [`09:00 ${zone}`] },
  ])
}
for (const zone of ['Mars/Olympus', 'local']) {
  check(`未知 Timezone 标签不得使用默认时区猜测 ${zone}`,
    `Date: September 30, 2026\nTime: 9:00 am\nTimezone: ${zone}`, [
      { date: '2026-09-30', dueAt: null, endAt: null, precision: 'time', evidence: [`Timezone: ${zone}`] },
    ])
}
check('显式 IANA 下英文 DST gap 不猜开始时刻', 'March 8, 2026 2:30 am America/New_York', [
  { date: '2026-03-08', dueAt: null, endAt: null, precision: 'time', timeZone: newYork, evidence: ['2:30 am America/New_York'] },
])
check('显式 IANA 下英文 DST fold 不猜开始时刻', 'November 1, 2026 1:30 am America/New_York', [
  { date: '2026-11-01', dueAt: null, endAt: null, precision: 'time', timeZone: newYork, evidence: ['1:30 am America/New_York'] },
])
check('范围结束落入 DST gap 时只保留唯一开始', 'March 8, 2026 1:30 am - 2:30 am America/New_York', [
  { date: '2026-03-08', dueAt: '2026-03-08T06:30:00Z', endAt: null, precision: 'time', timeZone: newYork, evidence: ['1:30 am - 2:30 am America/New_York'] },
])
check('范围结束落入 DST fold 时只保留唯一开始', 'November 1, 2026 12:30 am - 1:30 am America/New_York', [
  { date: '2026-11-01', dueAt: '2026-11-01T04:30:00Z', endAt: null, precision: 'time', timeZone: newYork, evidence: ['12:30 am - 1:30 am America/New_York'] },
])
check('范围开始不唯一时不单独产生结束提醒', 'November 1, 2026 1:30 am - 2:30 am America/New_York', [
  { date: '2026-11-01', dueAt: null, endAt: null, precision: 'time', timeZone: newYork, evidence: ['1:30 am - 2:30 am America/New_York'] },
])
check('跨 DST 跳时但两端唯一的同日正向范围', 'March 8, 2026 1:30 am - 3:30 am America/New_York', [
  { date: '2026-03-08', dueAt: '2026-03-08T06:30:00Z', endAt: '2026-03-08T07:30:00Z', precision: 'time', timeZone: newYork, evidence: ['1:30 am - 3:30 am America/New_York'] },
])
check('明确固定偏移可消除当地 DST fold 歧义', 'November 1, 2026 1:30 am UTC-04:00', [
  { date: '2026-11-01', dueAt: '2026-11-01T05:30:00Z', precision: 'time', evidence: ['1:30 am UTC-04:00'] },
])
for (const text of ['February 30, 2026 9:00 am', 'February 29, 2026 9:00 am', '31 April 2026 09:00']) {
  check(`无效英文日期不能退化为发送日 ${text}`, text, [])
}

check('不能把无效结束的 PM 传播到开始时间', 'September 30, 2026 09:00 - 13:00 pm', [
  { date: '2026-09-30', dueAt: '2026-09-30T01:00:00Z', endAt: null, precision: 'time' },
])
check('只在范围末尾写 PM 且跨中午时不猜开始', 'September 30, 2026 11:00–1:00 p.m.', [
  { date: '2026-09-30', dueAt: null, endAt: null, precision: 'time' },
])
check('范围末尾明确 PM 且同一时段顺序成立', 'September 30, 2026 9:00-10:30pm', [
  { date: '2026-09-30', dueAt: '2026-09-30T13:00:00Z', endAt: '2026-09-30T14:30:00Z', precision: 'time' },
])
check('开始明确 AM 但结束未写下午不猜跨中午', 'September 30, 2026 11:00 a.m. - 1:00', [
  { date: '2026-09-30', dueAt: '2026-09-30T03:00:00Z', endAt: null, precision: 'time' },
])
check('星期与公历日期冲突时不能设置提醒', 'September 30, 2026 (Tuesday) Time: 9:00 AM', [
  { date: '2026-09-30', dueAt: null, precision: 'time' },
])
for (const [zone, instant, resolved] of [
  ['utc', '2026-09-30T09:00:00Z', 'UTC'],
  ['Z', '2026-09-30T09:00:00Z', 'UTC'],
  ['+09:00', '2026-09-30T00:00:00Z', 'UTC+09:00'],
  ['america/new_york', '2026-09-30T13:00:00Z', newYork],
]) check(`明确时区不能静默使用本地默认值 ${zone}`, `September 30, 2026 09:00 ${zone}`, [
  { date: '2026-09-30', dueAt: instant, timeZone: resolved, precision: 'time', evidence: [`09:00 ${zone}`] },
])
for (const zone of ['Mars/Olympus', 'UTC+25', 'UTC+08:99', 'cst']) {
  check(`未知或非法时区保守留空 ${zone}`, `September 30, 2026 09:00 ${zone}`, [
    { date: '2026-09-30', dueAt: null, precision: 'time' },
  ])
}
check('URL 路径不能污染事件时区', 'Date: September 30, 2026\nTime: 09:00\nSpeaker profile: https://example.com/Asia/Tokyo', [
  { date: '2026-09-30', dueAt: '2026-09-30T01:00:00Z', timeZone: shanghai, precision: 'time' },
])
for (const title of ['Series - 1 CSE', '2026 AI seminar']) {
  check(`普通编号与院系简称不是时区 ${title}`, `${title}\nDate: September 30, 2026 (Wednesday)\nTime: 9:00 a.m. - 10:30 a.m.`, [
    { date: '2026-09-30', dueAt: '2026-09-30T01:00:00Z', endAt: '2026-09-30T02:30:00Z', timeZone: shanghai, precision: 'time' },
  ])
}
check('转发邮件头与研讨会日期各自有明确时刻',
  'Sent: September 23, 2026 11:18\nSubject: Series - 1 CSE\nDate: September 30, 2026 (Wednesday)\nTime: 9:00 a.m. - 10:30 a.m.', [
    { date: '2026-09-23', dueAt: '2026-09-23T03:18:00Z', precision: 'time' },
    { date: '2026-09-30', dueAt: '2026-09-30T01:00:00Z', endAt: '2026-09-30T02:30:00Z', precision: 'time' },
  ])

for (const date of ['2026-09-30', '2026/09/30', '2026年9月30日', 'September 30, 2026', '30 Sep 2026']) {
  check(`显式年份来自日期词本身 ${date}`, date, [
    { date: '2026-09-30', dueAt: null, precision: 'date', hasExplicitYear: true },
  ])
}
for (const date of ['9月30日', 'September 30', '30 Sep']) {
  check(`未给年份不能借时区偏移的四位数字 ${date}`, `${date} 09:00 UTC+0800`, [
    { date: '2026-09-30', dueAt: '2026-09-30T01:00:00Z', precision: 'time', hasExplicitYear: false },
  ])
}
check('相对日期不是明确四位年份', '明天上午9点', [
  { date: '2026-09-24', dueAt: '2026-09-24T01:00:00Z', precision: 'time', hasExplicitYear: false },
])
check('明年只依赖消息年份并非四位年份证据', '明年9月30日', [
  { date: '2027-09-30', dueAt: null, precision: 'date', hasExplicitYear: false },
])
check('孤立时刻没有明确年份', '09:00 UTC+0800', [
  { date: '2026-09-23', dueAt: '2026-09-23T01:00:00Z', precision: 'time', hasExplicitYear: false },
])

console.log(`todo date evidence tests passed (${checkedCases} cases)`)
