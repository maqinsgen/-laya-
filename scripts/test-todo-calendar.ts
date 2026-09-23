import assert from 'node:assert/strict'
import { buildTodoCalendar } from '../src/shared/todoCalendar.ts'
import type { TodoItem } from '../src/types/todo.ts'

function item(patch: Partial<TodoItem> = {}): TodoItem {
  return {
    id: 'calendar-test',
    title: '确认方案, 并回复; 项目组',
    details: '第一行\n第二行',
    dueAt: '2026-09-01T02:30:00.000Z',
    priority: 'high',
    status: 'pending',
    sourceType: 'wechat',
    sourceLabel: '项目群',
    sourceRef: 'message:calendar-test',
    sourcePreview: '',
    confidence: 0.9,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

const calendar = buildTodoCalendar([item()], new Date('2026-08-31T00:00:00.000Z'))
assert.match(calendar, /DTSTAMP:20260831T000000Z/)
assert.match(calendar, /DTSTART:20260901T023000Z/)
assert.match(calendar, /DTEND:20260901T030000Z/)
assert.match(calendar, /SUMMARY:确认方案\\, 并回复\\; 项目组/)
assert.match(calendar, /DESCRIPTION:第一行\\n第二行\\n来源：项目群/)
assert.match(calendar, /TRIGGER:-PT30M/)
const customReminder = buildTodoCalendar([item()], new Date('2026-08-31T00:00:00.000Z'), 120)
assert.match(customReminder, /TRIGGER:-PT120M/, '日历提醒必须使用用户配置的提前量')

const lecture = item({ dueAt: '2026-09-24T09:00:00+08:00', endAt: '2026-09-24T10:30:00+08:00' })
const lectureCalendar = buildTodoCalendar([lecture])
assert.match(lectureCalendar, /DTSTART:20260924T010000Z/)
assert.match(lectureCalendar, /DTEND:20260924T023000Z/, '讲座应保留 90 分钟真实时长')
const overnight = buildTodoCalendar([item({
  dueAt: '2026-09-24T23:30:00Z',
  endAt: '2026-09-25T01:00:00Z',
})])
assert.match(overnight, /DTEND:20260925T010000Z/, '跨日活动不能被截到开始当天')
const differentOffsets = buildTodoCalendar([item({
  dueAt: '2026-11-01T01:30:00-04:00',
  endAt: '2026-11-01T01:30:00-05:00',
})])
assert.match(differentOffsets, /DTSTART:20261101T053000Z/)
assert.match(differentOffsets, /DTEND:20261101T063000Z/, '应比较时间点，不能比较本地钟面字符串')
for (const endAt of [undefined, null, '', 'not-a-date', '2026-09-01T02:30:00Z', '2026-09-01T02:29:00Z']) {
  assert.match(buildTodoCalendar([item({ endAt })]), /DTEND:20260901T030000Z/, '缺少或无效的结束时间沿用 30 分钟')
}
for (const [minutes, expected] of [[0, 0], [-10, 0], [15.9, 15], [10081, 10080]]) {
  const result = buildTodoCalendar([lecture], new Date('2026-08-31T00:00:00Z'), minutes)
  assert.ok(result.includes(`TRIGGER:-PT${expected}M\r\n`))
  assert.equal(result.split('BEGIN:VALARM').length - 1, 1)
}

function unfolded(value: string): string {
  return value.replace(/\r\n[ \t]/g, '')
}

const updatedCalendar = buildTodoCalendar([
  item({ title: '更新后的讲座', endAt: '2026-09-01T04:00:00Z' }),
], new Date('2026-09-01T00:00:00Z'))
assert.equal(
  unfolded(updatedCalendar).match(/^UID:.*$/m)?.[0],
  unfolded(calendar).match(/^UID:.*$/m)?.[0],
  '重复导出以及修改标题或时间仍应使用同一 UID',
)
assert.ok(calendar.includes('UID:calendar-test@ciphertalk.local\r\n'), '保留既有 UID 命名空间')

const hostile = unfolded(buildTodoCalendar([item({
  id: 'safe\r\nBEGIN:VEVENT\rX-FAKE:uid',
  title: '标题\\,;\rX-FAKE:title',
  details: '一\r\n二\n三\rEND:VEVENT\u0000',
  sourceLabel: '来源\rBEGIN:VEVENT',
})]))
assert.equal(hostile.split('\r\nBEGIN:VEVENT\r\n').length - 1, 1)
assert.equal(hostile.split('\r\nEND:VEVENT\r\n').length - 1, 1)
assert.equal(hostile.split('\r\nBEGIN:VALARM\r\n').length - 1, 1)
assert.ok(!/^X-FAKE:/m.test(hostile), '用户文字不能注入日历属性')
assert.ok(hostile.includes('UID:safe\\nBEGIN:VEVENT\\nX-FAKE:uid@ciphertalk.local'))
assert.ok(hostile.includes('SUMMARY:标题\\\\\\,\\;\\nX-FAKE:title'))
assert.ok(hostile.includes('DESCRIPTION:一\\n二\\n三\\nEND:VEVENT\\n来源：来源\\nBEGIN:VEVENT'))
assert.ok(!hostile.includes('\u0000'))

const longTitle = `${'a'.repeat(66)}📅中文讲座${'📚 多行内容,;\\'.repeat(24)}`
const longCalendar = buildTodoCalendar([item({ title: longTitle, details: '汉字📅'.repeat(120) })])
assert.ok(longCalendar.includes('\r\n '), '长文本应产生折叠续行')
assert.ok(!/[\r\n]/.test(longCalendar.replace(/\r\n/g, '')), '只使用 CRLF 作为物理行结束符')
for (const line of longCalendar.split('\r\n')) {
  assert.ok(Buffer.byteLength(line, 'utf8') <= 75, '每个物理行不超过 75 个 UTF-8 字节')
  assert.equal(Buffer.from(line, 'utf8').toString('utf8'), line, '折叠不得拆开 emoji 的代理对')
}
const summary = unfolded(longCalendar).split('\r\n').find((line) => line.startsWith('SUMMARY:'))!
const restoredTitle = summary.slice('SUMMARY:'.length).replace(/\\([\\,;n])/g, (_, character: string) => character === 'n' ? '\n' : character)
assert.equal(restoredTitle, longTitle, '展开和解码后中文、emoji 与转义字符必须完整保留')

const multiple = buildTodoCalendar([lecture, item({ id: 'second-event' })])
assert.equal(multiple.split('\r\nBEGIN:VEVENT\r\n').length - 1, 2)
assert.equal(multiple.split('\r\nEND:VEVENT\r\n').length - 1, 2)
assert.ok(calendar.endsWith('END:VCALENDAR\r\n'))
assert.throws(() => buildTodoCalendar([item({ dueAt: null })]), /没有截止时间/)
assert.throws(() => buildTodoCalendar([item({ dueAt: 'not-a-date' })]), /截止时间无效/)

console.log('todo calendar export tests passed')
