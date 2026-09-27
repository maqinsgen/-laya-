import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHmac, pbkdf2Sync, timingSafeEqual } from 'node:crypto'

/**
 * SQLCipher 4 page authentication adapted from the MIT-licensed verifier in
 * resources/macos/login-capture/wechat_key_verify.py. See
 * THIRD_PARTY_NOTICES/WcdbKeyTool/{LICENSE,NOTICE} for the upstream attribution.
 * This module only reads database headers; it never opens SQLite or logs keys.
 */
const PAGE_SIZE = 4096
const SQLITE_HEADER = Buffer.from('SQLite format 3\0')
const CORE_DATABASE = /^(?:session|contact|message_.+)\.db$/i
const HEX_KEY = /^[0-9a-f]{64}$/i
const HEX_SALT = /^[0-9a-f]{32}$/i
const MAX_ENTRIES = 16_384
const MAX_DIRECTORIES = 1024
const MAX_DATABASES = 4096
const MAX_DEPTH = 8
const MAX_CANDIDATES = 4096
const MAX_VERIFICATIONS = 100_000

export const WECHAT_RAW_KEY_PROFILE = 'sqlcipher4-sha512' as const

export type WechatResolvedAccount = { wxid: string; dbStoragePath: string }
export type WechatDatabasePage = {
  relativePath: string
  salt: string
  /** The first page only. A short buffer is an unreadable/truncated candidate. */
  page: Buffer
  core: boolean
}
export type WechatDatabaseAccount = WechatResolvedAccount & {
  databases: WechatDatabasePage[]
  plaintextCount: number
}
export type WechatRawKeyCandidate = { keyHex: string; saltHex?: string }
export type WechatRawKeyCandidates =
  | ReadonlyMap<string, string | readonly string[]>
  | readonly (WechatRawKeyCandidate | string)[]
export type WechatKeyVerification = {
  success: boolean
  verified: number
  total: number
  coreVerified: number
  coreTotal: number
  /** Sensitive: main-process use only, never send this map through progress IPC. */
  keysBySalt: Record<string, string>
  /** A raw encryption key for the preferred database, never an account passphrase. */
  primaryKey?: string
  missingCount: number
  profile: typeof WECHAT_RAW_KEY_PROFILE
}

export class WechatDatabaseDiscoveryError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'WechatDatabaseDiscoveryError'
  }
}

function fail(code: string, message: string): never {
  throw new WechatDatabaseDiscoveryError(code, message)
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

function directoryExists(filename: string): boolean {
  try {
    const info = fs.lstatSync(filename)
    if (info.isSymbolicLink()) fail('DATABASE_SYMLINK', '数据库目录含符号链接，请选择实际账号目录。')
    return info.isDirectory()
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

/** Bounded streaming traversal avoids allocating an unbounded directory list. */
function entries(directory: string, visit: (entry: fs.Dirent) => void): void {
  const handle = fs.opendirSync(directory)
  let count = 0
  try {
    let entry: fs.Dirent | null
    while ((entry = handle.readSync())) {
      if (++count > MAX_ENTRIES) fail('DATABASE_LIMIT', '数据库目录文件过多，请选择具体账号目录。')
      visit(entry)
    }
  } finally { handle.closeSync() }
}

function checkedStorage(accountPath: string, selected: string): WechatResolvedAccount {
  const wxid = path.basename(accountPath)
  if (selected && wxid !== selected) fail('ACCOUNT_MISMATCH', '所选微信账号与数据库目录不一致，请重新选择账号目录。')
  const storage = path.join(accountPath, 'db_storage')
  if (!directoryExists(accountPath) || !directoryExists(storage)) {
    fail('ACCOUNT_NOT_FOUND', '没有找到所选账号的 db_storage，请选择已有微信数据的账号目录。')
  }
  // Ensure a change between discovery and canonicalization cannot redirect us.
  const canonicalAccount = fs.realpathSync(accountPath)
  const canonicalStorage = fs.realpathSync(storage)
  if (canonicalAccount !== accountPath || canonicalStorage !== storage) {
    fail('DATABASE_SYMLINK', '数据库目录含符号链接，请选择实际账号目录。')
  }
  return { wxid, dbStoragePath: canonicalStorage }
}

/** Accept exactly an account root, its db_storage, or a parent of account roots. */
export function resolveWechatAccount(dbPath: string, wxid?: string): WechatResolvedAccount {
  try {
    if (typeof dbPath !== 'string' || !dbPath.trim()) fail('DATABASE_PATH_REQUIRED', '请选择已有微信数据的账号目录。')
    const selected = String(wxid || '').trim()
    if (selected && (/[\\/\0]/.test(selected) || selected === '.' || selected === '..')) {
      fail('INVALID_ACCOUNT', '微信账号标识无效，请重新选择账号。')
    }
    const requestedRoot = path.resolve(dbPath.trim())
    if (!directoryExists(requestedRoot)) fail('DATABASE_DIRECTORY_UNREADABLE', '微信数据目录不存在或无法读取。')
    if (path.basename(requestedRoot).toLowerCase() === 'db_storage') directoryExists(path.dirname(requestedRoot))
    // System aliases in ancestors (e.g. /tmp on macOS) may be canonicalized;
    // an explicitly selected symlink, account symlink or storage symlink may not.
    const root = fs.realpathSync(requestedRoot)
    if (path.basename(root).toLowerCase() === 'db_storage') {
      return checkedStorage(path.dirname(root), selected)
    }
    if (directoryExists(path.join(root, 'db_storage'))) return checkedStorage(root, selected)
    if (selected) return checkedStorage(path.join(root, selected), selected)

    const accounts: WechatResolvedAccount[] = []
    entries(root, entry => {
      if (entry.isSymbolicLink()) return
      if (!entry.isDirectory()) return
      const accountPath = path.join(root, entry.name)
      if (directoryExists(path.join(accountPath, 'db_storage'))) {
        accounts.push(checkedStorage(accountPath, ''))
        if (accounts.length > 1) fail('MULTIPLE_ACCOUNTS', '此目录包含多个微信账号，请先选择具体账号后再获取密钥。')
      }
    })
    if (!accounts.length) fail('ACCOUNT_NOT_FOUND', '没有找到账号的 db_storage，请选择已有微信数据的账号目录。')
    return accounts[0]
  } catch (error) {
    if (error instanceof WechatDatabaseDiscoveryError) throw error
    fail('DATABASE_DIRECTORY_UNREADABLE', '微信数据目录不存在或无法读取。')
  }
}

function checkedDescendant(root: string, filename: string): fs.Stats {
  const relative = path.relative(root, filename)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('DATABASE_OUTSIDE_ACCOUNT', '数据库路径不属于所选微信账号。')
  }
  let current = root
  let info = fs.lstatSync(current)
  if (!info.isDirectory() || info.isSymbolicLink()) fail('DATABASE_SYMLINK', '数据库目录已变更，请重新选择实际账号目录。')
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    info = fs.lstatSync(current)
    if (info.isSymbolicLink()) fail('DATABASE_SYMLINK', '数据库目录含符号链接，请选择实际账号目录。')
  }
  if (fs.realpathSync(filename) !== filename) fail('DATABASE_SYMLINK', '数据库目录已变更，请重新选择实际账号目录。')
  return info
}

function databasePriority(database: WechatDatabasePage): number {
  const name = path.basename(database.relativePath).toLowerCase()
  return name === 'session.db' ? 0 : name === 'contact.db' ? 1 : database.core ? 2 : 3
}

/** Read at most 4096 bytes of each .db and keep every encrypted core in scope. */
export function discoverWechatDatabases(dbPath: string, wxid?: string): WechatDatabaseAccount {
  const account = resolveWechatAccount(dbPath, wxid)
  const databases: WechatDatabasePage[] = []
  let plaintextCount = 0
  let visitedEntries = 0
  let directories = 1
  let databaseCount = 0
  const pending = [{ directory: account.dbStoragePath, depth: 0 }]
  try {
    while (pending.length) {
      const current = pending.pop()!
      if (!checkedDescendant(account.dbStoragePath, current.directory).isDirectory()) {
        fail('DATABASE_DIRECTORY_UNREADABLE', '微信数据库目录无法读取。')
      }
      entries(current.directory, entry => {
        if (++visitedEntries > MAX_ENTRIES) fail('DATABASE_LIMIT', '数据库目录文件过多，请选择具体账号目录。')
        const filename = path.join(current.directory, entry.name)
        const metadata = checkedDescendant(account.dbStoragePath, filename)
        if (metadata.isDirectory()) {
          if (current.depth >= MAX_DEPTH || ++directories > MAX_DIRECTORIES) {
            fail('DATABASE_LIMIT', '数据库目录层级过深或目录过多，请选择具体账号目录。')
          }
          pending.push({ directory: filename, depth: current.depth + 1 })
          return
        }
        if (!/\.db$/i.test(entry.name)) return
        if (++databaseCount > MAX_DATABASES) fail('DATABASE_LIMIT', '数据库文件过多，请选择具体账号目录。')
        if (!metadata.isFile()) fail('DATABASE_REQUIRES_REGULAR_FILE', '数据库目录中存在无法读取的数据库文件。')
        const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0))
        try {
          const opened = fs.fstatSync(fd)
          const afterOpen = checkedDescendant(account.dbStoragePath, filename)
          if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino
            || opened.dev !== afterOpen.dev || opened.ino !== afterOpen.ino) {
            fail('DATABASE_CHANGED', '数据库目录在读取时发生变化，请重试。')
          }
          const buffer = Buffer.alloc(PAGE_SIZE)
          let length = 0
          while (length < PAGE_SIZE) {
            const read = fs.readSync(fd, buffer, length, PAGE_SIZE - length, length)
            if (!read) break
            length += read
          }
          const page = buffer.subarray(0, length)
          if (page.length >= 16 && page.subarray(0, 16).equals(SQLITE_HEADER)) { plaintextCount++; return }
          databases.push({
            relativePath: path.relative(account.dbStoragePath, filename),
            salt: page.subarray(0, 16).toString('hex'), page,
            core: CORE_DATABASE.test(entry.name),
          })
        } finally { fs.closeSync(fd) }
      })
    }
    databases.sort((left, right) => databasePriority(left) - databasePriority(right) || left.relativePath.localeCompare(right.relativePath))
    return { ...account, databases, plaintextCount }
  } catch (error) {
    if (error instanceof WechatDatabaseDiscoveryError) throw error
    fail('DATABASE_UNREADABLE', '无法读取所选账号的数据库，请检查目录权限后重试。')
  }
}

/** Fixed profile: 4096-byte SQLCipher 4 page, SHA-512, 80 reserved bytes. */
export function verifyWechatRawKey(keyHex: string, saltHex: string, page: Buffer): boolean {
  if (typeof keyHex !== 'string' || !HEX_KEY.test(keyHex) || typeof saltHex !== 'string' || !HEX_SALT.test(saltHex)
    || !Buffer.isBuffer(page) || page.length !== PAGE_SIZE || page.subarray(0, 16).equals(SQLITE_HEADER)) return false
  const salt = Buffer.from(saltHex, 'hex')
  if (!timingSafeEqual(salt, page.subarray(0, 16))) return false
  const key = Buffer.from(keyHex, 'hex')
  let macKey: Buffer | undefined
  try {
    for (let index = 0; index < salt.length; index++) salt[index] ^= 0x3a
    macKey = pbkdf2Sync(key, salt, 2, 32, 'sha512')
    const pageNumber = Buffer.alloc(4)
    pageNumber.writeUInt32LE(1)
    const expected = createHmac('sha512', macKey).update(page.subarray(16, 4032)).update(pageNumber).digest()
    return timingSafeEqual(expected, page.subarray(4032))
  } finally { key.fill(0); macKey?.fill(0) }
}

/** Authenticate each file. Matching a salt or just session.db is insufficient. */
export function verifyWechatKeyCandidates(account: WechatDatabaseAccount, rawCandidates: WechatRawKeyCandidates): WechatKeyVerification {
  const candidates = new Map<string, Set<string>>()
  let candidateCount = 0
  const add = (key: unknown, salt?: unknown) => {
    if (++candidateCount > MAX_CANDIDATES) fail('CANDIDATE_LIMIT', '候选密钥过多，请重新获取。')
    if (typeof key !== 'string' || !HEX_KEY.test(key)) return
    if (salt !== undefined && (typeof salt !== 'string' || !HEX_SALT.test(salt))) return
    const bucket = typeof salt === 'string' ? salt.toLowerCase() : ''
    if (!candidates.has(bucket)) candidates.set(bucket, new Set())
    candidates.get(bucket)!.add(key.toLowerCase())
  }
  if (Array.isArray(rawCandidates)) {
    for (const item of rawCandidates) {
      if (typeof item === 'string') add(item)
      else if (item && typeof item === 'object') add(item.keyHex, item.saltHex)
    }
  } else {
    for (const [salt, keys] of rawCandidates as ReadonlyMap<string, string | readonly string[]>) {
      if (typeof keys === 'string') add(keys, salt)
      else if (Array.isArray(keys)) for (const key of keys) add(key, salt)
    }
  }
  const groups = new Map<string, WechatDatabasePage[]>()
  for (const database of account.databases) {
    const salt = database.salt.toLowerCase()
    if (!groups.has(salt)) groups.set(salt, [])
    groups.get(salt)!.push(database)
  }
  const keysBySalt: Record<string, string> = Object.create(null)
  const verifiedDatabases = new Set<WechatDatabasePage>()
  let attempts = 0
  for (const [salt, databases] of groups) {
    const options = new Set([...(candidates.get(salt) || []), ...(candidates.get('') || [])])
    let best: WechatDatabasePage[] = []
    let bestCore = -1
    let selected: string | undefined
    for (const key of options) {
      const matches: WechatDatabasePage[] = []
      let core = 0
      for (const database of databases) {
        if (++attempts > MAX_VERIFICATIONS) fail('CANDIDATE_LIMIT', '候选验证量过大，请重新获取。')
        if (verifyWechatRawKey(key, salt, database.page)) { matches.push(database); if (database.core) core++ }
      }
      if (matches.length && (core > bestCore || (core === bestCore && matches.length > best.length))) {
        selected = key; best = matches; bestCore = core
      }
      if (matches.length === databases.length) break
    }
    // Exactly one key per salt can be persisted. Two different keys sharing a
    // salt must never produce success by independently counting both keys.
    if (selected) { keysBySalt[salt] = selected; for (const database of best) verifiedDatabases.add(database) }
  }
  const ordered = [...account.databases].sort((left, right) => databasePriority(left) - databasePriority(right))
  const preferred = ordered.find(database => verifiedDatabases.has(database))
  const coreTotal = ordered.filter(database => database.core).length
  const coreVerified = ordered.filter(database => database.core && verifiedDatabases.has(database)).length
  return {
    success: coreTotal > 0 && coreVerified === coreTotal,
    verified: verifiedDatabases.size, total: ordered.length, coreVerified, coreTotal,
    keysBySalt, primaryKey: preferred ? keysBySalt[preferred.salt.toLowerCase()] : undefined,
    missingCount: ordered.length - verifiedDatabases.size, profile: WECHAT_RAW_KEY_PROFILE,
  }
}
