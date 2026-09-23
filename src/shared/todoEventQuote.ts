import { collectTodoDateCandidates } from './todoDateEvidence'
import { recoverGeneratedEvidenceQuote } from './todoGeneratedEvidence'

type Span = { start: number; end: number }
const CANCELLED = /取消|无需|不需要|已结束|已完成|往年|历史|改期|待定|暂定|会议纪要|会议记录|录像|回放|\b(?:cancelled|canceled|cancellation|postponed|postponement|rescheduled|tentative|historical|previously|was held|took place|no longer|not required|recordings?|recorded|replay|meeting minutes)\b/i
const EVENT = /讲座|研讨会|会议|面试|考试|预约|活动|\b(?:seminar|lecture|meeting|conference|interview|appointment|workshop|webinar|exam)\b/i
const DATE_FIELD = /(?:\bDate|日期)[ \t]*[:：][ \t]*/gi
const TIME_FIELD = /(?:\bTime|时间)[ \t]*[:：][ \t]*/gi
const NEXT_FIELD = /\b(?:Date|Time|Time[ \t]*zone|Venue|Location|Zoom|Teams|Link|Speaker|Abstract|Title|Host|Organizer|Contact|RSVP|Registration|Notes?)\s*[:：]|(?:日期|时间|时区|地点|讲者|摘要|链接|备注)\s*[:：]/gi
const DATE_SIGNAL = /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)|\d{4}[-/年]\d|\d{1,2}[月/]\d|\d{1,2}(?:日|号)|明天|后天|昨天|今天|下周|本周|下个月|明年|月底|\b(?:tomorrow|yesterday|today|next\s+(?:week|month|year)|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i
// Do not treat an arbitrary department abbreviation (e.g. CSE) as a zone.
// An unknown abbreviation immediately after a clock remains in the returned
// Time field, where the date parser will reject it instead of losing it.
const ZONE_SIGNAL = /\b(?:UTC|GMT|CST|PST|EST|MST|CDT|PDT|EDT|MDT|BST|IST|AST|ADT|CET|CEST|EET|EEST|JST|KST|HKT|SGT|AEST|AEDT|ACST|ACDT|AKST|AKDT|MSK)\b|\b(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)\/[A-Za-z_+-]+|(?:\btime[ \t]*zone|时区)[ \t]*[:：]/i
const CLOCK_SIGNAL = /\b\d{1,2}[:：]\d{2}|\b\d{1,2}\s*[ap]\.?\s*m\.?\b|[0-9一二三四五六七八九十]{1,3}[点时](?:半|钟|\d|[一二三四五六七八九十])/i

function matches(pattern: RegExp, text: string): RegExpMatchArray[] {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags))]
}

/** Only date-valued fields inside a recognisable, grouped mail envelope. */
function envelopeDates(source: string, before: number): Span[] {
  const fields = matches(/\b(From|Sent|Date|To|Cc|Bcc|Subject)[ \t]*[:：]/gi, source.slice(0, before))
  const result: Span[] = []
  for (let index = 0; index < fields.length; index++) {
    if (fields[index][1].toLowerCase() !== 'from') continue
    const group: RegExpMatchArray[] = [fields[index]]
    for (let next = index + 1; next < fields.length && group.length < 7; next++) {
      if (fields[next][1].toLowerCase() === 'from' || fields[next].index! - fields[index].index! > 1_500) break
      group.push(fields[next])
    }
    const names = group.map(field => field[1].toLowerCase())
    const to = names.indexOf('to'), subject = names.indexOf('subject')
    // Some forwarded clients omit To entirely, but keep From/Sent/Subject.
    // A bare From/Date/Subject fragment is insufficient without To.
    if (subject < 0 || to < 0 && names.indexOf('sent') < 0) continue
    const finalEnvelopeField = Math.max(to, subject)
    for (let field = 1; field < finalEnvelopeField; field++) {
      if (!['sent', 'date'].includes(names[field])) continue
      // A bare Date field in the body is never removed. A header date must be
      // between From and a subsequent To/Subject field, not after the envelope.
      const start = group[field].index!, end = group[field + 1].index!
      const value = source.slice(start + group[field][0].length, end)
      if (!DATE_SIGNAL.test(value) || /\bTime\s*[:：]|时间\s*[:：]/i.test(value)) continue
      const dates = collectTodoDateCandidates(value, 946684800, 'UTC')
      if (dates.length !== 1 || !dates[0].hasExplicitYear) continue
      const remainder = value.replace(dates[0].quote, ' ').replace(/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, ' ')
      if (DATE_SIGNAL.test(remainder)) continue
      result.push({ start, end })
    }
  }
  return result
}

function withoutSpans(source: string, spans: Span[]): string {
  const sorted = [...spans].sort((left, right) => left.start - right.start)
  let result = '', cursor = 0
  for (const span of sorted) {
    if (span.end <= cursor) continue
    result += source.slice(cursor, Math.max(cursor, span.start)) + ' '
    cursor = span.end
  }
  return result + source.slice(cursor)
}

/**
 * Isolate a complete, source-verified event block when a forwarded envelope
 * pollutes whole-message date parsing. This is only evidence selection: the
 * caller still applies action/confidence/manual-time guards and parses in the
 * real event zone. It never selects among competing body events.
 */
export function selectVerifiedEventQuote(source: string, quote: unknown): string | null {
  if (typeof source !== 'string' || !source || source.length > 20_000 || CANCELLED.test(source)) return null
  const recovered = recoverGeneratedEvidenceQuote(source, quote)
  if (!recovered || !EVENT.test(source)) return null
  const start = source.indexOf(recovered), quoteEnd = start + recovered.length
  if (start < 0 || recoverGeneratedEvidenceQuote(source.slice(0, start), quote)
    || recoverGeneratedEvidenceQuote(source.slice(start + 1), quote)) return null

  const dateFields = matches(DATE_FIELD, recovered), timeFields = matches(TIME_FIELD, recovered)
  if (dateFields.length !== 1 || timeFields.length !== 1 || dateFields[0].index! >= timeFields[0].index!) return null
  const dateStart = start + dateFields[0].index!
  const timeStart = start + timeFields[0].index!
  const timeValueStart = timeStart + timeFields[0][0].length
  // Keep the whole Time field, even if the quote ends before its range/zone.
  // Known next-field labels support both multiline mail and flattened text.
  const following = source.slice(timeValueStart)
  const nextField = matches(NEXT_FIELD, following)[0]
  const newline = following.search(/[\r\n]/)
  const timeEnd = timeValueStart + Math.min(nextField?.index ?? following.length, newline < 0 ? following.length : newline)
  if (timeEnd - timeValueStart > 400 || timeEnd <= timeValueStart) return null
  let end = Math.max(quoteEnd, timeEnd)
  // A separately labelled adjacent zone is part of the same event. Retaining
  // its whole value also preserves unknown/unsupported zones for rejection.
  const adjacentZone = /^[ \t\r\n]*(?:time[ \t]*zone|时区)[ \t]*[:：][ \t]*/i.exec(source.slice(timeEnd))
  if (adjacentZone) {
    const zoneStart = timeEnd + adjacentZone[0].length
    const tail = source.slice(zoneStart)
    const next = matches(NEXT_FIELD, tail)[0]
    const line = tail.search(/[\r\n]/)
    const zoneEnd = zoneStart + Math.min(next?.index ?? tail.length, line < 0 ? tail.length : line)
    if (zoneEnd - zoneStart > 100 || !source.slice(zoneStart, zoneEnd).trim()) return null
    end = Math.max(end, zoneEnd)
  }
  if (end - start > 800) return null
  const selected = source.slice(start, end).trimEnd()
  end = start + selected.length
  // A quote ending halfway through a Date/Time value cannot conceal additional
  // digits or letters. Parse the complete source fields, never the short quote.
  const dates = collectTodoDateCandidates(source.slice(dateStart, end), 946684800, 'UTC')
  if (dates.length !== 1 || !dates[0].hasExplicitYear || dates[0].precision !== 'time' || !dates[0].dueAt) return null
  const parsedEnd = dateStart + Number(dates[0].id.split(':')[2])
  if (/^[ \t]*(?:[-–—~～至到]|to\b)/i.test(source.slice(parsedEnd, timeEnd))) return null
  const outside = withoutSpans(source, [{ start, end }, ...envelopeDates(source, start)])
    .replace(/(?:https?:\/\/|www\.)[^\s<>]+/gi, ' ')
    // A complete year-to-year span in a biography is not a calendar day.
    // Do not carve it from a longer number/date or exempt a year-month value.
    .replace(/(?<![\d/–—-])(\d{4})[ \t]*[-–—][ \t]*(\d{4})(?![\d/–—-])/g, (whole, first: string, last: string) => {
      return Number(first) >= 1 && Number(last) >= Number(first) ? ' ' : whole
    })
    // Academic series headings are not a second event date. Only an adjacent
    // Term/Semester label plus a consecutive year pair proves this exemption.
    .replace(/\b(\d{4})[ \t]*[-–/][ \t]*(\d{4}|\d{2})[ \t]+(?=(?:Term|Semester)\b)/gi, (whole, first: string, second: string) => {
      const next = Number(first) + 1
      return Number(second) === (second.length === 2 ? next % 100 : next) ? ' ' : whole
    })
  if (DATE_SIGNAL.test(outside) || ZONE_SIGNAL.test(outside) || CLOCK_SIGNAL.test(outside)
    || collectTodoDateCandidates(outside, 946684800, 'UTC').length > 0) return null
  return selected
}
