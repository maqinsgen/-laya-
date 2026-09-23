import type { TodoItem } from '../types/todo'

function escapeIcs(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r\n?|\n/g, '\\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
}

function foldIcsLine(value: string): string {
  // RFC 5545 counts UTF-8 octets, including the continuation space.
  const encoder = new TextEncoder()
  const lines: string[] = []
  let line = ''
  let bytes = 0
  for (const character of value) {
    const characterBytes = encoder.encode(character).length
    if (bytes + characterBytes > 75) {
      lines.push(line)
      line = ' '
      bytes = 1
    }
    line += character
    bytes += characterBytes
  }
  lines.push(line)
  return lines.join('\r\n')
}

function icsUtc(value: Date): string {
  return value.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

export function todoCalendarEndTime(startTime: number, endAt?: string | null): number {
  const specifiedEnd = endAt ? new Date(endAt).getTime() : NaN
  return specifiedEnd > startTime ? specifiedEnd : startTime + 30 * 60_000
}

export function buildTodoCalendar(items: TodoItem[], generatedAt = new Date(), remindBeforeMinutes = 30): string {
  const safeReminderMinutes = Math.max(0, Math.min(7 * 24 * 60, Math.floor(Number(remindBeforeMinutes) || 0)))
  const events = items.flatMap((item) => {
    if (!item.dueAt) throw new Error(`待办“${item.title}”没有截止时间`)
    const due = new Date(item.dueAt)
    if (Number.isNaN(due.getTime())) throw new Error(`待办“${item.title}”的截止时间无效`)
    const end = new Date(todoCalendarEndTime(due.getTime(), item.endAt))
    return [
      'BEGIN:VEVENT',
      `UID:${escapeIcs(item.id)}@ciphertalk.local`,
      `DTSTAMP:${icsUtc(generatedAt)}`,
      `DTSTART:${icsUtc(due)}`,
      `DTEND:${icsUtc(end)}`,
      `SUMMARY:${escapeIcs(item.title)}`,
      `DESCRIPTION:${escapeIcs(`${item.details}\n来源：${item.sourceLabel}`)}`,
      'BEGIN:VALARM',
      `TRIGGER:-PT${safeReminderMinutes}M`,
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeIcs(item.title)}`,
      'END:VALARM',
      'END:VEVENT',
    ]
  })

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CipherTalk//Todo Assistant//ZH-CN',
    'CALSCALE:GREGORIAN',
    ...events,
    'END:VCALENDAR',
    '',
  ].map(foldIcsLine).join('\r\n')
}
