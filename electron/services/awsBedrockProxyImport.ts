import fs from 'fs'
import os from 'os'
import path from 'path'
import { selectAwsProxyFromCcSwitchRows } from '../../src/shared/awsBedrockMantle'

export type LocalAwsProxyImport = {
  success: boolean
  apiKey?: string
  baseURL?: string
  model?: string
  source?: string
  error?: string
}

function ccSwitchDatabasePath(): string {
  return path.join(os.homedir(), '.cc-switch', 'cc-switch.db')
}

export function importLocalAwsBedrockProxy(): LocalAwsProxyImport {
  const dbPath = ccSwitchDatabasePath()
  if (!fs.existsSync(dbPath)) {
    return { success: false, error: '本机没有找到 CC-Switch 配置（~/.cc-switch/cc-switch.db）' }
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3') as new (filename: string, options?: { readonly?: boolean; fileMustExist?: boolean }) => {
      prepare(sql: string): { all: (...params: unknown[]) => Array<{ id: string; name: string; settings_config: string }> }
      close(): void
    }
    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    try {
      const rows = db.prepare(`
        SELECT id, name, settings_config
        FROM providers
        WHERE id LIKE ? OR id LIKE ? OR name LIKE ? OR name LIKE ?
        ORDER BY is_current DESC, created_at DESC
      `).all('%bedrock%', '%mantle%', '%Bedrock%', '%Mantle%')
      const selected = selectAwsProxyFromCcSwitchRows(rows)
      if (!selected) return { success: false, error: 'CC-Switch 里没有可用的 AWS Bedrock 密钥' }
      return { success: true, ...selected }
    } finally {
      db.close()
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
