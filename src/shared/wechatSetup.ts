/** Accept common paste formatting, but never mistake arbitrary 64-character text for a key. */
export function normalizeDatabaseKey(value: string): string {
  return value.trim().replace(/^0x/i, '').replace(/\s/g, '')
}

export function isValidDatabaseKey(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value)
}

export interface WechatSetupDraft {
  dbPath: string
  cachePath: string
  wxid: string
}

/** Setup drafts may retain paths, never database/image keys or account credentials. */
export function sanitizeWechatSetupDraft(value: unknown): WechatSetupDraft {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const text = (key: string, max: number) => typeof input[key] === 'string' ? (input[key] as string).slice(0, max) : ''
  return { dbPath: text('dbPath', 4096), cachePath: text('cachePath', 4096), wxid: text('wxid', 256) }
}
