import type { TodoEvidence } from '../types/todo'

export type GeneratedTodoSource = { key: string; text: string }
export type CheckedGeneratedTodo = {
  messageKey: string
  title: string
  details: string
  kind: 'action' | 'information'
  importance?: unknown
  reason?: unknown
  topics?: unknown
  dueAt?: string | null
  confidence?: number
  dateCandidateId?: unknown
  evidenceQuote: string
  /** Set only by the local review fallback, never copied from model output. */
  evidence?: TodoEvidence
}

const ID_FIELDS = ['messageKey', 'messageId', 'message_key', 'message_id'] as const
const ARRAY_FIELDS = ['items', 'todos', 'results'] as const
const RESPONSE_ERROR = 'AI 返回的结果格式无法读取，本批消息保留为可重试。'
const BINDING_ERROR = 'AI 返回了无法对应原消息的编号，本批消息保留为可重试。'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function responseItems(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value
  const record = asRecord(value)
  if (!record) return null
  const envelopes = ARRAY_FIELDS.filter(field => Array.isArray(record[field]))
  if (envelopes.length === 1) return record[envelopes[0]] as unknown[]
  if (envelopes.length > 1) return null
  if (ID_FIELDS.some(field => typeof record[field] === 'string' && record[field].trim())) return [record]
  return null
}

/** Read common JSON envelopes/fences without echoing provider output in errors. */
export function parseGeneratedTodoResponse(text: unknown): unknown[] {
  if (typeof text !== 'string' || !text.trim()) throw new Error(RESPONSE_ERROR)
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  try {
    const parsed = responseItems(JSON.parse(cleaned))
    if (parsed) return parsed
    throw new Error(RESPONSE_ERROR)
  } catch (error) {
    // Preserve the existing acceptance of a single JSON value surrounded by a
    // brief explanation. Do not combine two independently returned JSON values.
    for (const [open, close] of [['[', ']'], ['{', '}']]) {
      const start = cleaned.indexOf(open)
      const end = cleaned.lastIndexOf(close)
      if (start < 0 || end < start || start === 0 && end === cleaned.length - 1) continue
      if (/[\[\]{}]/.test(cleaned.slice(0, start) + cleaned.slice(end + 1))) continue
      try {
        const parsed = responseItems(JSON.parse(cleaned.slice(start, end + 1)))
        if (parsed) return parsed
      } catch { /* Try the other complete JSON shape, never raw fragments. */ }
    }
    throw new Error(RESPONSE_ERROR)
  }
}

type NormalizedText = { value: string; starts: number[]; ends: number[] }
function normalizeWithPositions(text: string): NormalizedText {
  let value = ''
  const starts: number[] = []
  const ends: number[] = []
  let offset = 0
  for (const character of text) {
    const start = offset
    offset += character.length
    const normalized = character.normalize('NFKC')
      .replace(/[\u200b-\u200d\u2060\uFEFF]/g, '')
      .replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    for (const part of normalized) {
      const next = /\s/u.test(part) ? ' ' : part
      if (next === ' ' && value.endsWith(' ')) {
        ends[ends.length - 1] = offset
        continue
      }
      value += next
      for (let unit = 0; unit < next.length; unit++) {
        starts.push(start)
        ends.push(offset)
      }
    }
  }
  return { value, starts, ends }
}

/** Match presentation differences only; return the actual continuous source span. */
export function recoverGeneratedEvidenceQuote(source: string, quote: unknown): string | null {
  if (typeof quote !== 'string') return null
  const trimmed = quote.trim()
  if (!trimmed || trimmed.length > 800) return null
  if (trimmed.length <= 400 && source.includes(trimmed)) return trimmed
  const sourceNormalized = normalizeWithPositions(source)
  const normalized = normalizeWithPositions(trimmed).value.trim()
  const variants = [normalized]
  if (normalized.length > 2 && (normalized.startsWith('"') && normalized.endsWith('"') || normalized.startsWith("'") && normalized.endsWith("'"))) {
    variants.push(normalized.slice(1, -1).trim())
  }
  for (const variant of variants) {
    if (!variant) continue
    const position = sourceNormalized.value.indexOf(variant)
    if (position < 0) continue
    const start = sourceNormalized.starts[position]
    const end = sourceNormalized.ends[position + variant.length - 1]
    if (start === undefined || end === undefined || end - start > 400) continue
    const original = source.slice(start, end)
    // Normalization can expand a character (e.g. a ligature). A partial match
    // inside that expansion does not prove the quoted text existed in source.
    if (normalizeWithPositions(original).value.trim() === variant) return original
  }
  return null
}

function nullableField(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' && (!value.trim() || /^(?:null|none)$/i.test(value.trim()))) return null
  return value
}

function sourceFor<T extends GeneratedTodoSource>(raw: Record<string, unknown>, sources: Map<string, T>): T {
  const populated = ID_FIELDS.map(field => nullableField(raw[field])).filter(value => value !== null)
  // An extraction's own id is not automatically a source message id. Accept it
  // only as a last-resort alias when it exactly equals a current source key.
  if (!populated.length && typeof raw.id === 'string') populated.push(raw.id)
  if (!populated.length || populated.some(value => typeof value !== 'string')) throw new Error(BINDING_ERROR)
  const ids = [...new Set(populated.map(value => (value as string).trim()))]
  if (ids.length !== 1 || !sources.has(ids[0])) throw new Error(BINDING_ERROR)
  return sources.get(ids[0])!
}

function reviewOriginal(message: GeneratedTodoSource, dateClaim: unknown): CheckedGeneratedTodo {
  const messageQuote = message.text.trim().slice(0, 400)
  return {
    messageKey: message.key, title: `待核对：${message.text.trim().slice(0, 115)}`, details: messageQuote,
    kind: 'information', importance: 50, topics: [], dueAt: null, dateCandidateId: null, confidence: 0,
    reason: 'AI 返回的字段或引文未能完整核对，已保留对应原消息供你确认，未设置自动提醒。',
    evidenceQuote: messageQuote,
    evidence: { engine: 'llm', messageQuote, needsReview: true, decisionConfidence: 0, dateStatus: dateClaim ? 'unconfirmed' : 'none' },
  }
}

/**
 * A malformed but identifiable item becomes source-only review information.
 * Unknown, missing or conflicting identifiers fail the batch; never bind by
 * array position, generated title or a guessed quotation.
 */
export function checkGeneratedTodoItems<T extends GeneratedTodoSource>(items: unknown[], messages: T[]): Array<{ raw: CheckedGeneratedTodo; message: T }> {
  const sources = new Map(messages.map(message => [message.key, message]))
  return items.map(value => {
    const record = asRecord(value)
    if (!record) throw new Error(BINDING_ERROR)
    const message = sourceFor(record, sources)
    const quoteInput = [record.evidenceQuote, record.evidence_quote, record.quote].find(value => typeof value === 'string' && value.trim())
    const quote = recoverGeneratedEvidenceQuote(message.text, quoteInput)
    const title = typeof record.title === 'string' ? record.title.trim() : ''
    const kind = typeof record.kind === 'string' ? record.kind.trim().toLowerCase() : ''
    const dateCandidateId = nullableField(record.dateCandidateId)
    const dueAt = nullableField(record.dueAt)
    if (!title || !['action', 'information'].includes(kind) || !quote) {
      return { message, raw: reviewOriginal(message, dateCandidateId || dueAt) }
    }
    return { message, raw: {
      messageKey: message.key, title, details: typeof record.details === 'string' ? record.details : '',
      kind: kind as 'action' | 'information', importance: record.importance, reason: record.reason, topics: record.topics,
      dueAt: typeof dueAt === 'string' ? dueAt.trim() : null, dateCandidateId,
      confidence: typeof record.confidence === 'number' && Number.isFinite(record.confidence) ? record.confidence : undefined,
      evidenceQuote: quote,
      // Deliberately do not spread record: generated evidence must never become
      // the trusted local evidence consumed by the checkpoint writer.
    } }
  })
}
