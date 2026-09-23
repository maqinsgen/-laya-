const ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const hexadecimal = entity[1]?.toLowerCase() === 'x'
      const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10)
      if (Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) return String.fromCodePoint(codePoint)
      return ''
    }
    return ENTITIES[entity.toLowerCase()] ?? match
  })
}

/** Convert untrusted email HTML to display-only plain text without remote resources. */
export function htmlMailToPlainText(value: string): string {
  return decodeHtmlEntities(
    String(value || '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(style|script|noscript|iframe|object|svg)[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6])\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
}

/** Preserve readable paragraphs while bounding memory and removing control noise. */
export function normalizeMailBody(value: string, max = 20_000): string {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max)
}
