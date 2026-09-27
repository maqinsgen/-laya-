import { safeStorage } from 'electron'
import { createHash } from 'crypto'
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { getUserDataPath } from './runtimePaths'
import { resolveWechatAccount } from './wechatDatabaseKeys'

export type WechatDatabaseKeyring = Record<string, string>
const FILE_NAME = 'wechat-database-keyrings.v1.json'
const MAX_FILE_BYTES = 4 * 1024 * 1024
export function isWechatDatabaseKeyring(value: unknown): value is WechatDatabaseKeyring {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.entries(value)
  return entries.length > 0 && entries.length <= 4096 && entries.every(([salt, key]) => /^[0-9a-f]{32}$/i.test(salt) && typeof key === 'string' && /^[0-9a-f]{64}$/i.test(key))
}
function identity(dbPath: string, wxid: string, primaryKey: string): string {
  if (!/^[0-9a-f]{64}$/i.test(primaryKey)) throw new Error('微信密钥格式无效。')
  const account = resolveWechatAccount(dbPath, wxid)
  const canonical = process.platform === 'win32' ? account.dbStoragePath.toLowerCase() : account.dbStoragePath
  return createHash('sha256').update(JSON.stringify([canonical, account.wxid, primaryKey.toLowerCase()])).digest('hex')
}
function readEntries(file: string): Record<string, string> {
  if (!existsSync(file)) return {}
  const bytes = readFileSync(file)
  if (bytes.length > MAX_FILE_BYTES) throw new Error('微信密钥存储过大，请重新配置。')
  try {
    const parsed = JSON.parse(bytes.toString('utf8'))
    if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) throw new Error()
    if (!Object.entries(parsed.entries).every(([id, encrypted]) => /^[0-9a-f]{64}$/.test(id) && typeof encrypted === 'string' && /^[A-Za-z0-9+/=]+$/.test(encrypted))) throw new Error()
    return parsed.entries
  } catch { throw new Error('微信密钥存储无法读取，请重新获取；其他配置已保留。') }
}
/** Only verified per-database keys are persisted, encrypted by the current OS user. */
export function saveWechatKeyring(dbPath: string, wxid: string, primaryKey: string, keys: WechatDatabaseKeyring): void {
  if (!isWechatDatabaseKeyring(keys) || !safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，未保存本次微信密钥。')
  const id = identity(dbPath, wxid, primaryKey)
  const directory = getUserDataPath()
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const file = join(directory, FILE_NAME)
  const entries = readEntries(file)
  entries[id] = safeStorage.encryptString(JSON.stringify({ id, keys })).toString('base64')
  const encoded = JSON.stringify({ version: 1, entries })
  if (Buffer.byteLength(encoded) > MAX_FILE_BYTES) throw new Error('微信密钥存储过大，未保存本次结果。')
  const temp = `${file}.${process.pid}.tmp`
  try { writeFileSync(temp, encoded, { mode: 0o600, flag: 'wx' }); renameSync(temp, file) }
  catch { throw new Error('无法保存本次微信密钥，请检查应用数据目录权限。') }
  finally { try { unlinkSync(temp) } catch { /* Already renamed or not created. */ } }
}
export function loadWechatKeyring(dbPath: string, wxid: string, primaryKey: string): WechatDatabaseKeyring | undefined {
  const file = join(getUserDataPath(), FILE_NAME)
  if (!existsSync(file)) return undefined
  const id = identity(dbPath, wxid, primaryKey)
  const encrypted = readEntries(file)[id]
  if (!encrypted) return undefined
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，请使用保存密钥时的 Windows 用户登录。')
  try {
    const decoded = JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'base64')))
    if (decoded.id !== id || !isWechatDatabaseKeyring(decoded.keys)) throw new Error()
    return decoded.keys
  } catch { throw new Error('微信逐库密钥无法解密，请在本机重新获取。') }
}
