export function todoExtractionDedupeKey(sourceRef: unknown, title: unknown, dueAt: string | null | undefined): string {
  const source = String(sourceRef || '').replace(/\s+/g, ' ').trim().toLowerCase()
  const normalizedTitle = String(title || '').replace(/\s+/g, ' ').trim().toLowerCase()
  const dueDay = typeof dueAt === 'string' ? dueAt.slice(0, 10) : ''
  return `${source}|${normalizedTitle}|${dueDay}`
}
