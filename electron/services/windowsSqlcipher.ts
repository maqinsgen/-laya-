import { closeSync, openSync, readSync } from 'fs'
import { dirname, join } from 'path'

export type WindowsSqlcipherKeyMaterial =
  | { kind: 'raw'; keyHex: string; saltHex: string }
  | { kind: 'passphrase'; value: Buffer | string }

type SqlcipherStatement = {
  readonly reader: boolean
  readonly readonly: boolean
  all(...params: any[]): Record<string, unknown>[]
  get(...params: any[]): unknown
}

export type WindowsSqlcipherHandle = {
  prepare(sql: string): SqlcipherStatement
  pragma(sql: string, options?: { simple?: boolean }): unknown
  key(value: Buffer): unknown
  close(): void
}

type SqlcipherConstructor = new (
  path: string,
  options: { readonly: true; fileMustExist: true; timeout: number },
) => WindowsSqlcipherHandle

const OPEN_ERROR = 'SQLCipher 无法只读打开数据库：请确认密钥、数据库版本和文件访问权限'
const RUNTIME_ERROR = '独立 SQLCipher 组件不可用，请重新安装包含 better-sqlite3-multiple-ciphers 的应用'
const READ_PRAGMAS = new Set([
  'table_info', 'table_xinfo', 'table_list', 'index_list', 'index_info',
  'index_xinfo', 'foreign_key_list', 'database_list', 'compile_options',
])

/**
 * Independent, read-only SQLCipher 4 reader. No wcdb_api.dll or license calls.
 * Its native dependency uses Node-API and includes Windows x64 prebuilds.
 * Open the original path so SQLite sees committed WAL frames and later writes;
 * never use immutable=1, create a plaintext copy, checkpoint, or change journals.
 */
export class WindowsSqlcipherReader {
  private static loadRuntime(): SqlcipherConstructor {
    const dependency = require('better-sqlite3-multiple-ciphers')
    const Database = dependency.default || dependency
    if (typeof Database !== 'function') throw new Error(RUNTIME_ERROR)
    // Its constructor lazily loads the addon. Use the pinned package's loader
    // to validate the native module without opening even an in-memory database.
    const packageRoot = dirname(require.resolve('better-sqlite3-multiple-ciphers/package.json'))
    const binding = require(join(packageRoot, 'lib', 'binding.js')).getBinding()
    if (typeof binding.Database !== 'function') throw new Error(RUNTIME_ERROR)
    return Database
  }

  static checkRuntime(): { ok: boolean; error?: string } {
    try {
      this.loadRuntime()
      return { ok: true }
    } catch {
      return { ok: false, error: RUNTIME_ERROR }
    }
  }

  open(filePath: string, material: WindowsSqlcipherKeyMaterial): WindowsSqlcipherHandle {
    let db: WindowsSqlcipherHandle | undefined
    let key: Buffer | undefined
    try {
      const header = Buffer.alloc(16)
      const fd = openSync(filePath, 'r')
      try {
        if (readSync(fd, header, 0, 16, 0) !== 16 || header.equals(Buffer.from('SQLite format 3\0'))) {
          throw new Error(OPEN_ERROR)
        }
      } finally { closeSync(fd) }
      if (material.kind === 'raw') {
        if (!/^[a-f\d]{64}$/i.test(material.keyHex) || !/^[a-f\d]{32}$/i.test(material.saltHex)) {
          throw new Error(OPEN_ERROR)
        }
        // Select only the key belonging to this database, including after a
        // restore/key rotation. Opening an empty file must never validate a key.
        if (header.toString('hex') !== material.saltHex.toLowerCase()) throw new Error(OPEN_ERROR)
        // raw: explicitly bypasses PBKDF2; a bare 32-byte Buffer is a passphrase.
        key = Buffer.from(`raw:${material.keyHex}${material.saltHex}`, 'ascii')
      } else {
        key = Buffer.isBuffer(material.value) ? Buffer.from(material.value) : Buffer.from(material.value, 'utf8')
        if (key.length === 0) throw new Error(OPEN_ERROR)
      }

      const Database = WindowsSqlcipherReader.loadRuntime()
      db = new Database(filePath, { readonly: true, fileMustExist: true, timeout: 1500 })
      db.pragma("cipher = 'sqlcipher'")
      db.pragma('legacy = 4')
      db.pragma('legacy_page_size = 4096')
      db.pragma('hmac_check = 1')
      db.key(key)
      // key() alone does not validate a key. Actually authenticate/read schema.
      db.prepare('SELECT count(*) AS count FROM sqlite_master').get()
      db.pragma('query_only = ON')
      return db
    } catch {
      try { db?.close() } catch { /* failed handles must not escape */ }
      throw new Error(OPEN_ERROR)
    } finally {
      key?.fill(0)
    }
  }

  query(db: WindowsSqlcipherHandle, sql: string, params: any[] = []): { ok: boolean; rows?: any[]; error?: string } {
    try {
      // Reject control/configuration statements as well as writes. Some SQLite
      // PRAGMAs execute while preparing, before stmt.readonly can be inspected.
      const cleaned = sql.replace(/^\s*(?:(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)\s*)*/, '').trimStart()
      const command = /^([a-z]+)/i.exec(cleaned)?.[1]?.toLowerCase()
      if (command === 'pragma') {
        const pragma = /^pragma\s+(?:(?:main|temp)\.)?([a-z_]+)/i.exec(cleaned)?.[1]?.toLowerCase()
        if (!pragma || !READ_PRAGMAS.has(pragma)) throw new Error('Unsupported query')
      } else if (!command || !['select', 'with', 'explain'].includes(command)) {
        throw new Error('Unsupported query')
      }
      const statement = db.prepare(sql)
      if (!statement.reader || !statement.readonly) throw new Error('Unsupported query')
      const rows = statement.all(...params).map(row => Object.fromEntries(
        Object.entries(row).map(([name, value]) => [name,
          Buffer.isBuffer(value) ? value.toString('hex') : typeof value === 'bigint' ? Number(value) : value,
        ]),
      ))
      return { ok: true, rows }
    } catch {
      // Do not include SQL, key material, original native errors or file paths.
      return { ok: false, error: 'SQLCipher 只读查询失败：请确认数据表、查询语句和数据库可访问性' }
    }
  }

  close(db: WindowsSqlcipherHandle): void {
    try { db.close() } catch { /* also safe for an already-closed handle */ }
  }
}
