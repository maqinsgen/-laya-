import type { TodoItem } from '../types/todo'
import { collectTodoDateCandidates, type TodoDateCandidate } from './todoDateEvidence'
import { selectVerifiedEventQuote } from './todoEventQuote'

// These rules only fill a missing time for an already accepted action. They do
// not classify a message as important and never turn a model's timestamp into evidence.
export function selectUnambiguousScheduledDate(text: string, dates: TodoDateCandidate[]): TodoDateCandidate | undefined {
  if (dates.length !== 1 || !dates[0].dueAt) return undefined
  if (/取消|无需|不需要|已结束|已完成|往年|历史|改期|待定|暂定|会议纪要|会议记录|录像|回放|\b(cancelled|canceled|postponed|rescheduled|tentative|historical|previously|was held|took place|no longer|not required|recordings?|recorded|replay|meeting minutes)\b/i.test(text)) return undefined
  const scheduled = /(?:讲座|研讨会|会议|面试|考试|预约|活动|截止|提交|交付|报名|参加|出席)|\b(?:seminar|lecture|meeting|conference|interview|appointment|workshop|webinar|exam|deadline|due|submit|attend|join|register)\b/i.test(text)
  return scheduled ? dates[0] : undefined
}

export function selectQuotedScheduledDate(source: string, quote: unknown, sentAt: number, timeZone: string): TodoDateCandidate | undefined {
  const event = selectVerifiedEventQuote(source, quote)
  // The scoped quote may begin at Date:, with the event name immediately
  // before it in source. The selector already checked that event context.
  const dates = event ? collectTodoDateCandidates(event, sentAt, timeZone) : []
  return dates.length === 1 && dates[0].dueAt ? dates[0] : undefined
}

/** Upgrade old pending action cards locally, without re-scanning or model calls. */
export function recoverTodoSourceTime(item: TodoItem, timeZone: string, now = Date.now()): TodoItem {
  const evidence = item.evidence
  if (item.status !== 'pending' || item.sourceType === 'manual' || item.insight?.kind !== 'action'
    || item.feedback === 'not-useful' || !evidence || evidence.engine === 'laya'
    || (evidence.engine === 'jev' && !item.dueAt)
    || evidence.dateStatus === 'user-confirmed' || evidence.needsReview
    || !Number.isFinite(item.confidence) || item.confidence < .8
    || (item.dueAt && item.endAt)) return item
  const text = item.sourcePreview || evidence.messageQuote
  if (!text) return item
  const hasAnchor = typeof item.sourceCreatedAt === 'number' && Number.isFinite(item.sourceCreatedAt) && item.sourceCreatedAt > 0
  // Old cards did not retain sending time. A fixed anchor is used solely to
  // parse explicit full dates; relative/yearless dates are rejected below.
  const dates = collectTodoDateCandidates(text, hasAnchor ? item.sourceCreatedAt! : 946684800, evidence.timeZone || timeZone)
  const candidate = selectUnambiguousScheduledDate(text, dates)
    || selectQuotedScheduledDate(text, evidence.messageQuote, hasAnchor ? item.sourceCreatedAt! : 946684800, evidence.timeZone || timeZone)
  if (!candidate?.dueAt || !candidate.hasExplicitYear
    || Date.parse(candidate.dueAt) <= now || (item.dueAt && Date.parse(item.dueAt) !== Date.parse(candidate.dueAt))) return item
  if (item.dueAt && !candidate.endAt) return item
  const recovered: TodoItem = {
    ...item, dueAt: candidate.dueAt, endAt: candidate.endAt || null,
    updatedAt: now,
    evidence: { ...evidence, dateStatus: 'exact', date: candidate.date, dateQuote: candidate.quote, timeZone: candidate.timeZone || timeZone },
  }
  if (!item.dueAt) delete recovered.remindedAt
  return recovered
}
