import type { TodoConnector, TodoScanState, TodoSourceType } from '../types/todo'

export function buildTodoSourceFailure(errors: string[]): string {
  const unique = Array.from(new Set(errors.map((error) => String(error || '').replace(/\s+/g, ' ').trim()).filter(Boolean)))
  if (!unique.length) return ''
  const visible = unique.slice(0, 5)
  const suffix = unique.length > visible.length ? `；另有 ${unique.length - visible.length} 个来源失败` : ''
  return `信息来源读取不完整：${visible.join('；')}${suffix}`
}

export function isTodoConnectorEnabled(
  connectors: TodoConnector[] | undefined,
  sourceType: TodoSourceType,
  fallback = true,
): boolean {
  const connector = Array.isArray(connectors)
    ? connectors.find((entry) => entry.type === sourceType)
    : undefined
  return connector ? connector.enabled !== false : fallback
}

export function todoSourceScanOutcome(
  sourceFailure: string,
  collectedMessages: number,
): 'complete' | 'partial' | 'failed' {
  if (!sourceFailure) return 'complete'
  return collectedMessages > 0 ? 'partial' : 'failed'
}

export function finalizeTodoScanState(
  current: TodoScanState,
  input: {
    outcome: 'complete' | 'partial'
    completedAt: number
    completedFingerprints: string[]
    analyzedMessages: number
    extractedTodos: number
    sourceFailure: string
    maxFingerprints?: number
  },
): TodoScanState {
  const maxFingerprints = Math.max(1, Math.floor(input.maxFingerprints || 20_000))
  const fingerprints = Array.from(new Set([
    ...(current.processedFingerprints || []),
    ...input.completedFingerprints,
  ])).slice(-maxFingerprints)
  return {
    ...current,
    lastSuccessfulScanAt: input.outcome === 'complete' ? input.completedAt : current.lastSuccessfulScanAt,
    processedFingerprints: fingerprints,
    analyzedMessages: current.analyzedMessages + input.analyzedMessages,
    extractedTodos: current.extractedTodos + input.extractedTodos,
    lastError: input.sourceFailure,
  }
}
