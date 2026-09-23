import type {
  TodoItem,
  TodoSyncDocument,
  TodoSyncEnvelope,
  TodoSyncPreferences,
  TodoTombstone,
} from '../types/todo'

const SYNC_AAD = 'CipherTalkTodoSync:v1'
const DEFAULT_PBKDF2_ITERATIONS = 310_000
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000

function cryptoApi(): Crypto {
  if (!globalThis.crypto?.subtle) throw new Error('当前运行环境不支持 Web Crypto')
  return globalThis.crypto
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64')
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(value, 'base64'))
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  cryptoApi().getRandomValues(bytes)
  return bytes
}

function stableTodoWinner(left: TodoItem, right: TodoItem): TodoItem {
  if (left.updatedAt !== right.updatedAt) return left.updatedAt > right.updatedAt ? left : right
  // 极少数同毫秒冲突需要跨设备得到相同结果，使用内容序列化作为稳定 tie-breaker。
  return JSON.stringify(left) >= JSON.stringify(right) ? left : right
}

function normalizeDocument(document: TodoSyncDocument): TodoSyncDocument {
  if (document.schemaVersion !== 1) throw new Error(`不支持的同步数据版本：${document.schemaVersion}`)
  if (!document.deviceId || !Number.isFinite(document.revision) || !Array.isArray(document.items) || !Array.isArray(document.tombstones)) {
    throw new Error('同步数据结构不完整')
  }
  return {
    schemaVersion: 1,
    deviceId: String(document.deviceId),
    revision: Math.max(0, Math.floor(document.revision)),
    updatedAt: Number(document.updatedAt) || 0,
    items: document.items,
    tombstones: document.tombstones,
    preferences: {
      reminderEnabled: document.preferences?.reminderEnabled !== false,
      remindBeforeMinutes: Math.max(0, Math.floor(Number(document.preferences?.remindBeforeMinutes) || 0)),
      includeSourcePreview: document.preferences?.includeSourcePreview === true,
    },
  }
}

async function deriveKey(secret: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  if (secret.trim().length < 12) throw new Error('同步密码至少需要 12 个字符')
  const subtle = cryptoApi().subtle
  const material = await subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export function generateTodoSyncSecret(): string {
  return bytesToBase64(randomBytes(32)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function redactTodoForSync(item: TodoItem, includeSourcePreview: boolean): TodoItem {
  return includeSourcePreview ? { ...item } : { ...item, sourcePreview: '',
    // Jev details are a verbatim excerpt, not a generated summary. Keep only the short title by default.
    ...(['jev', 'laya'].includes(item.evidence?.engine || '') ? { details: '' } : {}),
    ...(item.evidence ? { evidence: { ...item.evidence, messageQuote: '', dateQuote: undefined } } : {}),
  }
}

export async function encryptTodoSyncDocument(
  document: TodoSyncDocument,
  secret: string,
  options: { salt?: Uint8Array; iterations?: number } = {},
): Promise<TodoSyncEnvelope> {
  const normalized = normalizeDocument(document)
  const salt = options.salt || randomBytes(16)
  const iv = randomBytes(12)
  const iterations = Math.max(100_000, Math.floor(options.iterations || DEFAULT_PBKDF2_ITERATIONS))
  const key = await deriveKey(secret, salt, iterations)
  const plaintext = new TextEncoder().encode(JSON.stringify(normalized))
  const encrypted = await cryptoApi().subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: new TextEncoder().encode(SYNC_AAD) },
    key,
    plaintext,
  )
  return {
    format: 'ciphertalk-todo-sync',
    version: 1,
    kdf: {
      name: 'PBKDF2-SHA-256',
      iterations,
      salt: bytesToBase64(salt),
    },
    cipher: {
      name: 'AES-256-GCM',
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    },
    createdAt: Date.now(),
  }
}

export async function decryptTodoSyncEnvelope(envelope: TodoSyncEnvelope, secret: string): Promise<TodoSyncDocument> {
  if (envelope?.format !== 'ciphertalk-todo-sync' || envelope.version !== 1) throw new Error('无法识别的 CipherTalk 同步文件')
  if (envelope.kdf?.name !== 'PBKDF2-SHA-256' || envelope.cipher?.name !== 'AES-256-GCM') throw new Error('同步文件使用了不支持的加密算法')
  const salt = base64ToBytes(envelope.kdf.salt)
  const iv = base64ToBytes(envelope.cipher.iv)
  const ciphertext = base64ToBytes(envelope.cipher.ciphertext)
  const key = await deriveKey(secret, salt, envelope.kdf.iterations)
  try {
    const plaintext = await cryptoApi().subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, additionalData: new TextEncoder().encode(SYNC_AAD) },
      key,
      ciphertext as BufferSource,
    )
    return normalizeDocument(JSON.parse(new TextDecoder().decode(plaintext)) as TodoSyncDocument)
  } catch {
    throw new Error('同步密码错误，或加密文件已损坏')
  }
}

export function mergeTodoSyncDocuments(
  localInput: TodoSyncDocument,
  remoteInput: TodoSyncDocument,
  localDeviceId: string,
  now = Date.now(),
): TodoSyncDocument {
  const local = normalizeDocument(localInput)
  const remote = normalizeDocument(remoteInput)
  const items = new Map<string, TodoItem>()
  for (const item of [...local.items, ...remote.items]) {
    const current = items.get(item.id)
    items.set(item.id, current ? stableTodoWinner(current, item) : item)
  }

  const tombstones = new Map<string, TodoTombstone>()
  for (const tombstone of [...local.tombstones, ...remote.tombstones]) {
    const current = tombstones.get(tombstone.id)
    if (!current || tombstone.deletedAt > current.deletedAt || (tombstone.deletedAt === current.deletedAt && tombstone.deviceId > current.deviceId)) {
      tombstones.set(tombstone.id, tombstone)
    }
  }
  for (const [id, tombstone] of tombstones) {
    const item = items.get(id)
    if (item && tombstone.deletedAt >= item.updatedAt) items.delete(id)
    if (item && item.updatedAt > tombstone.deletedAt) tombstones.delete(id)
  }

  const remoteIsNewer = remote.updatedAt > local.updatedAt + MAX_CLOCK_SKEW_MS
    || (Math.abs(remote.updatedAt - local.updatedAt) <= MAX_CLOCK_SKEW_MS && remote.revision > local.revision)
  const preferences: TodoSyncPreferences = remoteIsNewer ? remote.preferences : local.preferences
  return {
    schemaVersion: 1,
    deviceId: localDeviceId,
    revision: Math.max(local.revision, remote.revision) + 1,
    updatedAt: now,
    items: [...items.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)),
    tombstones: [...tombstones.values()].sort((a, b) => b.deletedAt - a.deletedAt || a.id.localeCompare(b.id)),
    preferences,
  }
}

export function createEmptyTodoSyncDocument(
  deviceId: string,
  preferences: TodoSyncPreferences = { reminderEnabled: true, remindBeforeMinutes: 30, includeSourcePreview: false },
): TodoSyncDocument {
  return {
    schemaVersion: 1,
    deviceId,
    revision: 0,
    updatedAt: Date.now(),
    items: [],
    tombstones: [],
    preferences,
  }
}
