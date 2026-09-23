export type TodoDateCandidate = {
  id: string
  quote: string
  date: string
  dueAt: string | null
  endAt?: string | null
  timeZone?: string
  hasExplicitYear?: boolean
  precision: 'date' | 'time'
}

type CalendarDate = { year: number; month: number; day: number }
type LocalParts = CalendarDate & { hour: number; minute: number; second: number }
type DateToken = { start: number; end: number; date: CalendarDate | null; period?: string; hasExplicitYear?: boolean }
type Clock = { start: number; end: number; hour: number; minute: number; valid: boolean; period?: string; meridiem?: string }
type ZoneEvidence = { name: string; offsetMinutes?: number }

const DAY_MS = 86_400_000
const NUMBER = '[0-9零〇一二两三四五六七八九十]{1,3}'
const PERIOD = '(?:凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|晚间|夜里)'
const CLOCK_SOURCE = `(${PERIOD})?[ \\t]*(${NUMBER})[ \\t]*(?:[:：]([0-9]{2})|[点时](?:钟)?[ \\t]*(半|一刻|三刻|${NUMBER}(?:分)?)?)`
const ENGLISH_CLOCK_SOURCE = '\\d{1,2}(?::[0-9]{2})?[ \\t]*[ap]\\.?[ \\t]*m\\.?(?![A-Za-z])'
const MONTH_SOURCE = '(?:January|Jan\\.?|February|Feb\\.?|March|Mar\\.?|April|Apr\\.?|May|June|Jun\\.?|July|Jul\\.?|August|Aug\\.?|September|Sept?\\.?|October|Oct\\.?|November|Nov\\.?|December|Dec\\.?)'
const ENGLISH_DATE_SOURCE = `\\b(?:${MONTH_SOURCE}[ \\t]+\\d{1,2}(?:st|nd|rd|th)?(?:[ \\t]*,[ \\t]*\\d{4}|[ \\t]+\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?[ \\t]+${MONTH_SOURCE}(?:[ \\t]*,[ \\t]*\\d{4}|[ \\t]+\\d{4})?)\\b`
const WEEKDAY_SOURCE = '(?:Monday|Mon\\.?|Tuesday|Tues?\\.?|Wednesday|Wed\\.?|Thursday|Thurs?\\.?|Thu\\.?|Friday|Fri\\.?|Saturday|Sat\\.?|Sunday|Sun\\.?)'
const WEEKDAY_PAREN = `[（(][ \\t]*(${WEEKDAY_SOURCE})[ \\t]*[）)]`
const DATE_SOURCE = [
  ENGLISH_DATE_SOURCE,
  '\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}',
  '\\d{4}年\\d{1,2}月\\d{1,2}(?:日|号)?',
  '(?:(?:今年|明年|后年|去年)[ \\t]*)?\\d{1,2}月\\d{1,2}(?:日|号)?',
  '(?:(?:今年|明年|后年|去年)[ \\t]*)?\\d{1,2}/\\d{1,2}',
  '(?:(?:本月|这个月|下下个月|上上个月|下个月|上个月|下月|上月)[ \\t]*)?\\d{1,2}(?:日|号)',
  '(?:下下|上上|下|上|本|这)(?:个)?(?:周|星期|礼拜)[一二三四五六日天1-7]',
  '大后天|今天|今日|明天|明日|后天|昨天|昨日|前天|今晚|今早|今晨|明早|明晚',
].join('|')
const VAGUE_DATE = /(?:下|上|本|这)(?:个)?(?:周|星期|礼拜)|(?:周|星期|礼拜)[一二三四五六日天1-7末]|月底|月末|年底|年末|改天|某天|择日|待定|过几天|近期|近日|稍后|晚点|以后|之后|今明|未来|节后|节前|下个?月|明年|后年|[0-9零〇一二两三四五六七八九十几]+(?:个)?(?:天|日|周|星期|礼拜|月|年)(?:前|后|内)|[0-9一二三四五六七八九十]+月|\d{4}(?:年|[./-]\d{1,2})|春节|端午|中秋|国庆|元旦|圣诞|除夕|五一|生日|纪念日|假期|\b(?:tomorrow|yesterday|next\s+(?:week|month|year)|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i
const UNCERTAIN_CLOCK_SUFFIX = /^[ \t]*(?:几|多|左右|前后)/

function utcTime(date: CalendarDate, hour = 0, minute = 0, second = 0): number {
  // Date.UTC interprets years 0–99 as 1900–1999. setUTCFullYear does not.
  const value = new Date(0)
  value.setUTCFullYear(date.year, date.month - 1, date.day)
  value.setUTCHours(hour, minute, second, 0)
  return value.getTime()
}

function validDate(date: CalendarDate): boolean {
  if (![date.year, date.month, date.day].every(Number.isInteger) || date.year < 1 || date.year > 9999 || date.month < 1 || date.month > 12) return false
  const leap = date.year % 4 === 0 && (date.year % 100 !== 0 || date.year % 400 === 0)
  return date.day >= 1 && date.day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][date.month - 1]
}

function addDays(date: CalendarDate, days: number): CalendarDate {
  const value = new Date(utcTime(date) + days * DAY_MS)
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() }
}

function dateKey(date: CalendarDate): string {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`
}

function localParts(formatter: Intl.DateTimeFormat, timestamp: number): LocalParts {
  const values: Record<string, number> = {}
  for (const part of formatter.formatToParts(timestamp)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value)
  }
  return { year: values.year, month: values.month, day: values.day, hour: values.hour, minute: values.minute, second: values.second }
}

function chineseNumber(raw: string): number {
  if (/^\d+$/.test(raw)) return Number(raw)
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if (raw.length === 1 && raw in digits) return digits[raw]
  const tens = raw.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/)
  return tens ? (tens[1] ? digits[tens[1]] : 1) * 10 + (tens[2] ? digits[tens[2]] : 0) : NaN
}

function resolveDateToken(raw: string, anchor: CalendarDate): { date: CalendarDate | null; period?: string; hasExplicitYear: boolean } {
  let match = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/) || raw.match(/^(\d{4})年(\d{1,2})月(\d{1,2})(?:日|号)?$/)
  const numericYear = !!match
  let date: CalendarDate | null = null
  let period: string | undefined
  const english = new RegExp(`^(${MONTH_SOURCE})[ \\t]+(\\d{1,2})(?:st|nd|rd|th)?(?:[ \\t]*,[ \\t]*(\\d{4})|[ \\t]+(\\d{4}))?$`, 'i').exec(raw)
    || new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?[ \\t]+(${MONTH_SOURCE})(?:[ \\t]*,[ \\t]*(\\d{4})|[ \\t]+(\\d{4}))?$`, 'i').exec(raw)
  if (english) {
    const monthFirst = /^[A-Za-z]/.test(raw)
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
    date = { year: Number(english[3] || english[4] || anchor.year),
      month: months.indexOf(english[monthFirst ? 1 : 2].slice(0, 3).toLowerCase()) + 1,
      day: Number(english[monthFirst ? 2 : 1]) }
  } else if (match) {
    date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
  } else if ((match = raw.match(/^(?:(今年|明年|后年|去年)[ \t]*)?(\d{1,2})月(\d{1,2})(?:日|号)?$/))) {
    const offset: Record<string, number> = { 今年: 0, 明年: 1, 后年: 2, 去年: -1 }
    date = { year: anchor.year + (offset[match[1]] || 0), month: Number(match[2]), day: Number(match[3]) }
  } else if ((match = raw.match(/^(?:(今年|明年|后年|去年)[ \t]*)?(\d{1,2})\/(\d{1,2})$/))) {
    const offsets: Record<string, number> = { 今年: 0, 明年: 1, 后年: 2, 去年: -1 }
    date = { year: anchor.year + (offsets[match[1]] || 0), month: Number(match[2]), day: Number(match[3]) }
  } else if ((match = raw.match(/^(?:(本月|这个月|下下个月|上上个月|下个月|上个月|下月|上月)[ \t]*)?(\d{1,2})(?:日|号)$/))) {
    const offsets: Record<string, number> = { 本月: 0, 这个月: 0, 下下个月: 2, 上上个月: -2, 下个月: 1, 上个月: -1, 下月: 1, 上月: -1 }
    const monthIndex = anchor.year * 12 + anchor.month - 1 + (offsets[match[1]] || 0)
    date = { year: Math.floor(monthIndex / 12), month: (monthIndex % 12) + 1, day: Number(match[2]) }
  } else if ((match = raw.match(/^(下下|上上|下|上|本|这)(?:个)?(?:周|星期|礼拜)([一二三四五六日天1-7])$/))) {
    const offsets: Record<string, number> = { 下下: 2, 上上: -2, 下: 1, 上: -1, 本: 0, 这: 0 }
    const days: Record<string, number> = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 }
    const weekday = match[2] in days ? days[match[2]] : Number(match[2]) - 1
    const currentWeekday = (new Date(utcTime(anchor)).getUTCDay() + 6) % 7
    date = addDays(anchor, offsets[match[1]] * 7 + weekday - currentWeekday)
  } else {
    const offsets: Record<string, number> = { 今天: 0, 今日: 0, 今晚: 0, 今早: 0, 今晨: 0, 明天: 1, 明日: 1, 明早: 1, 明晚: 1, 后天: 2, 大后天: 3, 昨天: -1, 昨日: -1, 前天: -2 }
    if (raw in offsets) date = addDays(anchor, offsets[raw])
    if (/晚$/.test(raw)) period = '晚上'
    if (/[早晨]$/.test(raw)) period = '早上'
  }
  return { date: date && validDate(date) ? date : null, period,
    hasExplicitYear: numericYear || !!(english?.[3] || english?.[4]) }
}

function parseClock(match: RegExpExecArray, absoluteStart: number, impliedPeriod?: string): Clock {
  let hour = chineseNumber(match[2])
  const minuteRaw = match[3] || match[4] || ''
  const minute = minuteRaw === '半' ? 30 : minuteRaw === '一刻' ? 15 : minuteRaw === '三刻' ? 45
    : minuteRaw ? chineseNumber(minuteRaw.replace(/分$/, '')) : 0
  const period = match[1] || impliedPeriod
  let valid = Number.isInteger(hour) && Number.isInteger(minute) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
  if (period && valid) {
    if (['下午', '傍晚', '晚上', '晚间', '夜里'].includes(period)) {
      // “晚上十二点” can mean the next day's midnight; do not invent a day shift.
      if (hour === 0 || (hour === 12 && period !== '下午')) valid = false
      else if (hour < 12) hour += 12
    } else if (period === '中午') {
      if (hour === 1 || hour === 2) hour += 12
      else if (hour < 11 || hour > 14) valid = false
    } else if (hour >= 12) valid = false
  }
  return { start: absoluteStart, end: absoluteStart + match[0].length, hour, minute, valid, period }
}

function readClock(text: string, start: number, impliedPeriod?: string): Clock | undefined {
  const english = new RegExp(`^(${ENGLISH_CLOCK_SOURCE})`, 'i').exec(text.slice(start))
  let clock: Clock | undefined
  if (english) {
    const parts = /^(\d{1,2})(?::(\d{2}))?[ \t]*([ap])\.?[ \t]*m\.?$/i.exec(english[0])!
    const hour = Number(parts[1])
    const minute = Number(parts[2] || 0)
    const meridiem = parts[3].toLowerCase()
    clock = { start, end: start + english[0].length, hour: hour % 12 + (meridiem === 'p' ? 12 : 0), minute,
      meridiem, valid: hour >= 1 && hour <= 12 && minute >= 0 && minute <= 59 }
  } else {
    const match = new RegExp(`^${CLOCK_SOURCE}`, 'u').exec(text.slice(start))
    if (match) clock = parseClock(match, start, impliedPeriod)
  }
  if (clock && (/[0-9分秒:：]/.test(text[clock.end] || '') || UNCERTAIN_CLOCK_SUFFIX.test(text.slice(clock.end)))) clock.valid = false
  return clock
}

function dateClockStart(text: string, token: DateToken): { start: number; validWeekday: boolean } {
  const tail = text.slice(token.end)
  // Newlines are permitted only in an adjacent, explicitly labelled Time field.
  // No arbitrary prose, location field or second date can be skipped.
  const structured = new RegExp(`^[ \\t\\r\\n]*(?:${WEEKDAY_PAREN})?[ \\t\\r\\n]*[,，]?[ \\t\\r\\n]*(?:Time|时间)[ \\t]*[:：][ \\t]*`, 'i').exec(tail)
  const inline = new RegExp(`^[ \\t\\u3000]*(?:${WEEKDAY_PAREN})?[ \\t\\u3000]*(?:[，,的][ \\t\\u3000]*)?(?:at[ \\t]+)?`, 'i').exec(tail)!
  const bridge = structured || inline
  const weekday = bridge[1]?.slice(0, 3).toLowerCase()
  const validWeekday = !weekday || !!token.date && ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(utcTime(token.date)).getUTCDay()] === weekday
  return { start: token.end + bridge[0].length, validWeekday }
}

function clockRange(text: string, start: Clock): { end?: Clock; quoteEnd: number } {
  const connector = /^[ \t]*(?:[-–—~～至到]|to\b)[ \t]*/i.exec(text.slice(start.end))
  if (!connector) return { quoteEnd: start.end }
  const end = readClock(text, start.end + connector[0].length, start.period)
  if (!end) return { quoteEnd: start.end }
  // A single explicit AM/PM or Chinese period can govern both ends of a range.
  if (end.valid && !end.meridiem && !end.period && start.meridiem && end.hour >= 1 && end.hour <= 12) {
    end.hour = end.hour % 12 + (start.meridiem === 'p' ? 12 : 0)
  } else if (end.valid && !start.meridiem && !start.period && end.meridiem && start.hour >= 1 && start.hour <= 12) {
    start.hour = start.hour % 12 + (end.meridiem === 'p' ? 12 : 0)
    // “11:00–1:00 p.m.” could cross noon. Inheriting PM would move an
    // unqualified start to 23:00; do not schedule that unsupported assumption.
    if (end.hour * 60 + end.minute <= start.hour * 60 + start.minute) start.valid = false
  }
  return { end, quoteEnd: end.end }
}

function messageZone(text: string, fallback: string): { zone?: ZoneEvidence; spans: { start: number; end: number }[] } {
  const evidence: ZoneEvidence[] = []
  const spans: { start: number; end: number }[] = []
  const urls = [...text.matchAll(/(?:https?:\/\/|www\.)[^\s<>]+/gi)].map(match => ({ start: match.index!, end: match.index! + match[0].length }))
  const insideUrl = (start: number) => urls.some(url => start >= url.start && start < url.end)
  const clockPrefix = new RegExp(`(?:${ENGLISH_CLOCK_SOURCE}|${CLOCK_SOURCE})[ \\t]*[（(]?[ \\t]*$`, 'iu')
  const zoneIsAttached = (start: number) => clockPrefix.test(text.slice(0, start))
    || /(?:\btime[ \t]*zone|时区)[ \t]*[:：][ \t]*[（(]?[ \t]*$/i.test(text.slice(0, start))
  let unknown = false
  const source = /\b(?:UTC|GMT)(?:[ \t]*[+-][ \t]*\d{1,4}(?::\d{1,2})?)?\b|\b(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)\/[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)?\b/gi
  for (const match of text.matchAll(source)) {
    if (insideUrl(match.index!)) continue
    spans.push({ start: match.index!, end: match.index! + match[0].length })
    if (!zoneIsAttached(match.index!)) { unknown = true; continue }
    const offset = /^(?:UTC|GMT)(?:[ \t]*([+-])[ \t]*(\d{1,2})(?::?(\d{2}))?)?$/i.exec(match[0])
    if (offset) {
      const hour = Number(offset[2] || 0), minute = Number(offset[3] || 0)
      if (hour > 14 || minute > 59 || (hour === 14 && minute !== 0) || /[:\d]/.test(text[match.index! + match[0].length] || '')) { unknown = true; continue }
      const offsetMinutes = (hour * 60 + minute) * (offset[1] === '-' ? -1 : 1)
      evidence.push({ name: offsetMinutes === 0 ? 'UTC' : `UTC${offsetMinutes < 0 ? '-' : '+'}${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, offsetMinutes })
    } else {
      try { evidence.push({ name: new Intl.DateTimeFormat('en', { timeZone: match[0] }).resolvedOptions().timeZone }) }
      catch { unknown = true }
    }
  }
  const suffix = new RegExp(`(?:${ENGLISH_CLOCK_SOURCE}|${CLOCK_SOURCE})[ \\t]*\\(?(?<zone>Z|[+-]\\d{2}:?\\d{2}|[A-Za-z]+/[A-Za-z_+-]+(?:/[A-Za-z_+-]+)?)(?![A-Za-z0-9_])`, 'giu')
  for (const match of text.matchAll(suffix)) {
    const raw = match.groups!.zone
    const start = match.index! + match[0].lastIndexOf(raw)
    if (insideUrl(start)) continue
    if (spans.some(span => span.start === start)) continue
    // A minus with a colon can also be a range delimiter. Leave that case
    // unresolved when separated by whitespace, rather than choose an offset.
    if (raw.startsWith('-') && raw.includes(':') && !/[ \t(]$/.test(text.slice(0, start))) continue
    if (/^[+-]/.test(raw) && /^[ \t]*[ap]\.?[ \t]*m/i.test(text.slice(start + raw.length))) continue
    spans.push({ start, end: start + raw.length })
    if (raw.toUpperCase() === 'Z') evidence.push({ name: 'UTC', offsetMinutes: 0 })
    else if (/^[+-]/.test(raw)) {
      const parts = /^([+-])(\d{2}):?(\d{2})$/.exec(raw)!
      const hour = Number(parts[2]), minute = Number(parts[3])
      if (hour > 14 || minute > 59 || (hour === 14 && minute > 0) || raw.startsWith('-') && raw.includes(':')) unknown = true
      else evidence.push({ name: `UTC${parts[1]}${parts[2]}:${parts[3]}`, offsetMinutes: (hour * 60 + minute) * (parts[1] === '-' ? -1 : 1) })
    } else unknown = true
  }
  // Abbreviations such as CST are geographically ambiguous. An unknown explicit
  // Timezone field or clock suffix must never silently use the computer's zone.
  for (const match of text.matchAll(/\b(?:CST|PST|EST|MST|CDT|PDT|EDT|MDT|BST|IST|AST|ADT|CET|CEST|EET|EEST|JST|KST|HKT|SGT|AEST|AEDT|ACST|ACDT|AKST|AKDT|MSK)\b/gi)) {
    if (insideUrl(match.index!)) continue
    unknown = true
    spans.push({ start: match.index!, end: match.index! + match[0].length })
  }
  for (const match of text.matchAll(/(?:\btime[ \t]*zone|时区)[ \t]*[:：][ \t]*([^\r\n,;。]+)/gi)) {
    const valueStart = match.index! + match[0].indexOf(match[1])
    if (!spans.some(span => span.start === valueStart)) {
      unknown = true
      spans.push({ start: valueStart, end: valueStart + match[1].trimEnd().length })
    }
  }
  const unknownClockSuffix = new RegExp(`(?:${ENGLISH_CLOCK_SOURCE}|${CLOCK_SOURCE})[ \\t]+\\(?(?<zone>[A-Z]{2,5})\\b`, 'gu')
  for (const match of text.matchAll(unknownClockSuffix)) {
    if (insideUrl(match.index!)) continue
    const abbreviation = match.groups!.zone
    if (!['AM', 'PM', 'UTC', 'GMT'].includes(abbreviation)) {
      unknown = true
      const start = match.index! + match[0].lastIndexOf(abbreviation)
      spans.push({ start, end: start + abbreviation.length })
    }
  }
  const names = new Set(evidence.map(zone => zone.name))
  return { zone: unknown || names.size > 1 ? undefined : evidence[0] || { name: fallback }, spans: spans.sort((a, b) => a.start - b.start) }
}

/**
 * Build message-local evidence IDs, never scheduled tasks. Omitted years use the
 * sending year; omitted months use the sending month. They never roll forward
 * merely because a date is in the past. Weeks start on Monday. Only explicit
 * relative words (e.g. 明年/下月/明天/下周一) can move that calendar anchor.
 *
 * A clock binds only to the immediately preceding date, or its adjacent Time
 * field with an optional weekday annotation; intervening prose is not skipped.
 * Clock-only messages use the sending day
 * only when the entire text has no other exact or vague date. Date-only evidence
 * has no invented default hour. Ambiguous/nonexistent local DST times have null
 * dueAt; downstream code must not turn them into a reminder time.
 */
export function collectTodoDateCandidates(text: string, messageTimeSeconds: number, timeZone: string): TodoDateCandidate[] {
  if (typeof text !== 'string' || !text || typeof messageTimeSeconds !== 'number' || !Number.isFinite(messageTimeSeconds) ||
    typeof timeZone !== 'string' || !timeZone.trim() || /^[+-]|^GMT[+-]/i.test(timeZone.trim())) return []
  const timestamp = messageTimeSeconds * 1000
  const sentAt = new Date(timestamp)
  if (!Number.isFinite(sentAt.getTime()) || sentAt.getUTCFullYear() < 1 || sentAt.getUTCFullYear() > 9999) return []
  let formatter: Intl.DateTimeFormat
  let anchor: LocalParts
  const zoneEvidence = messageZone(text, timeZone.trim())
  try {
    formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      timeZone: zoneEvidence.zone?.offsetMinutes === undefined ? zoneEvidence.zone?.name || timeZone.trim() : 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    })
    anchor = localParts(formatter, timestamp + (zoneEvidence.zone?.offsetMinutes || 0) * 60_000)
  } catch { return [] }
  if (!validDate(anchor)) return []

  const tokens: DateToken[] = []
  const dates = new RegExp(DATE_SOURCE, 'giu')
  for (let match = dates.exec(text); match; match = dates.exec(text)) {
    const start = match.index
    const end = start + match[0].length
    // Avoid carving a date out of a larger number, identifier or incomplete
    // relative expression (e.g. “2026-09-222” / “下下下周一”). Invalid tokens
    // still suppress orphan-clock fallback later.
    const boundaryInvalid = /[0-9A-Za-z上下本这]/.test(text[start - 1] || '') || /[0-9]/.test(text[end] || '') ||
      (/\d$/.test(match[0]) && /[:：]/.test(text[end] || '')) ||
      (/(?:周|星期|礼拜)[一二三四五六1-7]$/.test(match[0]) && /[日号]/.test(text[end] || '')) ||
      (/^\d{1,2}(?:月|日|号|\/)/.test(match[0]) && /(?:明年|后年|去年|下周|上周|下个月|上个月|下月|上月|月底|周末)(?:的)?[ \t]*$/.test(text.slice(0, start)))
    tokens.push({ start, end, ...resolveDateToken(match[0], anchor), ...(boundaryInvalid ? { date: null } : {}) })
  }

  const groupedDates = new Set<DateToken>()
  for (let index = 1; index < tokens.length; index++) {
    const previous = tokens[index - 1], current = tokens[index]
    if (/^[ \t\r\n,，、;；]*(?:(?:and|or|to|Dates?[ \t]*:|和|或|至|到|[-–—/])[ \t\r\n,，、;；]*)?$/i.test(text.slice(previous.end, current.start))) {
      groupedDates.add(previous)
      groupedDates.add(current)
    }
  }

  const offsetsByDate = new Map<string, Set<number>>()
  const dueAtFor = (date: CalendarDate, clock: Clock): string | null => {
    if (!clock.valid || !zoneEvidence.zone) return null
    const wallTime = utcTime(date, clock.hour, clock.minute)
    if (zoneEvidence.zone.offsetMinutes !== undefined) return new Date(wallTime - zoneEvidence.zone.offsetMinutes * 60_000).toISOString()
    const key = dateKey(date)
    let offsets = offsetsByDate.get(key)
    if (!offsets) {
      offsets = new Set<number>()
      // Collect offsets on both sides of a nearby transition, then round-trip
      // every possible instant. Two matches are a fold; zero matches are a gap.
      const midday = utcTime(date, 12)
      for (let hours = -48; hours <= 48; hours += 6) {
        const sample = midday + hours * 3_600_000
        const local = localParts(formatter, sample)
        offsets.add(utcTime(local, local.hour, local.minute, local.second) - sample)
      }
      offsetsByDate.set(key, offsets)
    }
    const instants = new Set<number>()
    for (const offset of offsets) {
      const candidate = wallTime - offset
      const local = localParts(formatter, candidate)
      if (dateKey(local) === key && local.hour === clock.hour && local.minute === clock.minute && local.second === 0) instants.add(candidate)
    }
    return instants.size === 1 ? new Date([...instants][0]).toISOString() : null
  }

  const candidates: TodoDateCandidate[] = []
  const includeAdjacentZone = (end: number): number => {
    for (const span of zoneEvidence.spans) {
      if (span.start >= end && /^[ \t\r\n,，(（]*(?:(?:time[ \t]*zone|时区)[ \t]*[:：][ \t]*)?$/i.test(text.slice(end, span.start))) {
        end = span.end
        if (/[)）]/.test(text[end] || '')) end++
      }
    }
    return end
  }
  for (const token of tokens) {
    if (!token.date) continue
    let end = token.end
    let clock: Clock | undefined
    const bridge = dateClockStart(text, token)
    if (!groupedDates.has(token)) clock = readClock(text, bridge.start, token.period)
    if (clock && !bridge.validWeekday) clock.valid = false
    const range = clock ? clockRange(text, clock) : undefined
    if (clock) end = includeAdjacentZone(range!.quoteEnd)
    const dueAt = clock ? dueAtFor(token.date, clock) : null
    const rangeEndAt = range?.end && dueAt ? dueAtFor(token.date, range.end) : null
    candidates.push({
      id: `date:${token.start}:${end}`, quote: text.slice(token.start, end), date: dateKey(token.date),
      dueAt, precision: clock ? 'time' : 'date',
      ...(range?.end ? { endAt: rangeEndAt && dueAt && rangeEndAt > dueAt ? rangeEndAt : null } : {}),
      ...(zoneEvidence.zone ? { timeZone: zoneEvidence.zone.name } : {}),
      hasExplicitYear: token.hasExplicitYear === true,
    })
    if (candidates.length === 8) return candidates
  }

  if (tokens.length || VAGUE_DATE.test(text)) return candidates
  const clocks = new RegExp(`${ENGLISH_CLOCK_SOURCE}|${CLOCK_SOURCE}`, 'giu')
  for (let match = clocks.exec(text); match; match = clocks.exec(text)) {
    const start = match.index
    const clock = readClock(text, start)!
    const range = clockRange(text, clock)
    clocks.lastIndex = Math.max(clocks.lastIndex, range.quoteEnd)
    if (!clock.valid || /[0-9A-Za-z]/.test(text[start - 1] || '') || /[0-9分秒:：]/.test(text[clock.end] || '') ||
      zoneEvidence.spans.some(span => start >= span.start && start < span.end) ||
      UNCERTAIN_CLOCK_SUFFIX.test(text.slice(clock.end)) ||
      /^(建议|意见|看法|要求|说明|原因|问题|注意)/.test(text.slice(clock.end))) continue
    const end = includeAdjacentZone(range.quoteEnd)
    const dueAt = dueAtFor(anchor, clock)
    const rangeEndAt = range.end && dueAt ? dueAtFor(anchor, range.end) : null
    candidates.push({
      id: `date:${start}:${end}`, quote: text.slice(start, end), date: dateKey(anchor),
      dueAt, precision: 'time',
      ...(range.end ? { endAt: rangeEndAt && dueAt && rangeEndAt > dueAt ? rangeEndAt : null } : {}),
      ...(zoneEvidence.zone ? { timeZone: zoneEvidence.zone.name } : {}),
      hasExplicitYear: false,
    })
    if (candidates.length === 8) break
  }
  return candidates
}
