export function normalizeTodoImapPort(port: unknown, secure: boolean): number {
  const fallback = secure ? 993 : 143
  const parsed = Math.floor(Number(port || fallback))
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(65_535, parsed))
}
