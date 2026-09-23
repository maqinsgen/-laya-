export type TodoScanUsageInput = {
  fingerprintHits: number
  uniqueMessages: number
  candidateMessages: number
  inputChars: number
  outputChars?: number
  pricing?: {
    input?: number
    output?: number
  }
}

export type TodoScanUsage = {
  scannedMessages: number
  analyzedMessages: number
  cacheHits: number
  sentMessages: number
  estimatedCostUsd: number
}

/** models.dev / catalog 的单价按每百万 token；本地没有 tokenizer，按 4 字符约 1 token 估算。 */
export function estimateTodoScanCostUsd(
  inputChars: number,
  outputChars = 0,
  pricing?: { input?: number; output?: number },
): number {
  const inputPrice = Math.max(0, Number(pricing?.input) || 0)
  const outputPrice = Math.max(0, Number(pricing?.output) || 0)
  if (inputPrice <= 0 && outputPrice <= 0) return 0
  const inputTokens = Math.max(0, Number(inputChars) || 0) / 4
  const outputTokens = Math.max(0, Number(outputChars) || 0) / 4
  return Number(((inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000).toFixed(6))
}

export function summarizeTodoScanUsage(input: TodoScanUsageInput): TodoScanUsage {
  const uniqueMessages = Math.max(0, Math.floor(Number(input.uniqueMessages) || 0))
  const candidateMessages = Math.max(0, Math.min(uniqueMessages, Math.floor(Number(input.candidateMessages) || 0)))
  const fingerprintHits = Math.max(0, Math.floor(Number(input.fingerprintHits) || 0))
  return {
    scannedMessages: uniqueMessages,
    analyzedMessages: candidateMessages,
    cacheHits: fingerprintHits + Math.max(0, uniqueMessages - candidateMessages),
    sentMessages: candidateMessages,
    estimatedCostUsd: estimateTodoScanCostUsd(input.inputChars, input.outputChars, input.pricing),
  }
}

export function formatTodoScanCost(usd?: number): string {
  const value = Number(usd) || 0
  if (value <= 0) return '成本取决于所选服务商'
  if (value < 0.01) return `约 $${value.toFixed(4)}`
  return `约 $${value.toFixed(2)}`
}
