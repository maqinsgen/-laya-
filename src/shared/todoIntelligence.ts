import type { TodoFeedback, TodoInsight, TodoItem, TodoSettings } from '../types/todo'

export function normalizeTopics(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((tag): tag is string => typeof tag === 'string')
    .map((tag) => tag.trim().toLowerCase().slice(0, 24)).filter(Boolean))].slice(0, 4)
}

function finiteScore(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.max(0, Math.min(100, value))) : fallback
}

/** Rebuild from explicit votes, so changing or withdrawing a vote never double counts. */
export function learnTodoPreferences(items: TodoItem[], now = Date.now()) {
  const votes = new Map<string, { topic: string; useful: number; notUseful: number; weight: number }>()
  let useful = 0
  let notUseful = 0
  const seen = new Set<string>()
  const recent = [...items].sort((a, b) => (b.feedbackAt || 0) - (a.feedbackAt || 0))
  for (const item of recent) {
    if (!item.feedback || !['useful', 'not-useful'].includes(item.feedback) || item.sourceType === 'manual') continue
    // Multiple extracted tasks from one message are one piece of evidence.
    const key = item.sourceRef || item.id
    if (seen.has(key)) continue
    seen.add(key)
    if (item.feedback === 'useful') useful++
    else notUseful++
    const ageDays = Math.max(0, now - (item.feedbackAt || item.updatedAt)) / 86_400_000
    const weight = Math.pow(0.5, ageDays / 90)
    for (const topic of normalizeTopics(item.insight?.topics)) {
      const entry = votes.get(topic) || { topic, useful: 0, notUseful: 0, weight: 0 }
      if (item.feedback === 'useful') entry.useful++
      else entry.notUseful++
      entry.weight += weight * (item.feedback === 'useful' ? 1 : -1)
      votes.set(topic, entry)
    }
  }
  const topics = [...votes.values()].map((entry) => ({
    ...entry,
    adjustment: Math.round(15 * entry.weight / (3 + entry.useful + entry.notUseful)),
  })).sort((a, b) => Math.abs(b.adjustment) - Math.abs(a.adjustment) || a.topic.localeCompare(b.topic)).slice(0, 24)
  return { useful, notUseful, topics }
}

export function buildTodoIntelligenceContext(settings: TodoSettings, items: TodoItem[], now = Date.now()): string {
  const learned = learnTodoPreferences(items, now)
  return JSON.stringify({
    userProvidedContext: String(settings.personalContext || '').trim().slice(0, 2000),
    // No raw historical messages or feedback examples are sent to the model.
    feedbackTopics: settings.learningEnabled === false ? [] : learned.topics.map(({ topic, useful, notUseful }) => ({ topic, useful, notUseful })),
  })
}

export function assessTodoImportance(
  raw: { kind?: unknown; importance?: unknown; reason?: unknown; topics?: unknown; priority?: unknown },
  dueAt: string | null,
  items: TodoItem[],
  learningEnabled = true,
  now = Date.now(),
): TodoInsight {
  const kind = raw.kind === 'information' ? 'information' : 'action'
  const topics = normalizeTopics(raw.topics)
  const baseScore = finiteScore(raw.importance, raw.priority === 'high' ? 80 : raw.priority === 'low' ? 35 : 55)
  const matched = learningEnabled ? learnTodoPreferences(items, now).topics.filter((entry) => topics.includes(entry.topic)) : []
  const adjustment = matched.length ? Math.round(matched.reduce((sum, entry) => sum + entry.adjustment, 0) / matched.length) : 0
  const due = dueAt ? new Date(dueAt).getTime() : NaN
  // Explicit deadlines remain visible even after negative preference feedback.
  const deadlineFloor = kind === 'action' && Number.isFinite(due) && due <= now + 48 * 3_600_000 ? 75 : 0
  const score = Math.max(deadlineFloor, Math.min(100, Math.max(0, baseScore + adjustment)))
  return {
    kind, score, baseScore, adjustment: score - baseScore, topics,
    reason: typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim().slice(0, 400) : '模型未提供具体理由，请结合原消息判断。',
  }
}

export function applyTodoFeedback(item: TodoItem, feedback: TodoFeedback | null, now = Date.now()): TodoItem {
  if (feedback !== null && feedback !== 'useful' && feedback !== 'not-useful') throw new Error('无效的消息反馈')
  const originalStatus = item.feedback === 'not-useful' ? (item.feedbackPreviousStatus || 'pending') : item.status
  return {
    ...item, feedback, feedbackAt: now, updatedAt: now,
    status: feedback === 'not-useful' ? 'dismissed' : (item.feedback === 'not-useful' ? originalStatus : item.status),
    feedbackPreviousStatus: feedback === 'not-useful' ? originalStatus : undefined,
  }
}

export function compareTodoImportance(left: TodoItem, right: TodoItem): number {
  const score = (item: TodoItem) => item.insight?.score ?? (item.priority === 'high' ? 80 : item.priority === 'low' ? 35 : 55)
  return score(right) - score(left) || (left.dueAt || '9999').localeCompare(right.dueAt || '9999') || right.createdAt - left.createdAt
}
