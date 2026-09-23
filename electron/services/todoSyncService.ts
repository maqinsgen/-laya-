import { randomUUID } from 'crypto'
import { net, safeStorage } from 'electron'
import { ConfigService } from './config'
import {
  createEmptyTodoSyncDocument,
  decryptTodoSyncEnvelope,
  encryptTodoSyncDocument,
  generateTodoSyncSecret,
  mergeTodoSyncDocuments,
  redactTodoForSync,
} from '../../src/shared/todoSync'
import type {
  TodoStoredSyncConfig,
  TodoSyncConfigInput,
  TodoSyncDocument,
  TodoSyncEnvelope,
  TodoSyncResult,
  TodoSyncState,
} from '../../src/types/todo'

const SYNC_INTERVAL_MS = 5 * 60 * 1000
const REMOTE_POLL_MS = 15 * 60 * 1000
const REQUEST_TIMEOUT_MS = 30_000

function publicState(config: TodoStoredSyncConfig, syncing: boolean): TodoSyncState {
  return {
    configured: Boolean(config.endpoint && config.username && config.encryptedPassword && config.encryptedSecret),
    enabled: config.enabled,
    endpoint: config.endpoint,
    username: config.username,
    remotePath: config.remotePath,
    autoSync: config.autoSync,
    includeSourcePreview: config.includeSourcePreview,
    deviceId: config.deviceId,
    lastSyncAt: config.lastSyncAt,
    lastError: config.lastError,
    syncing,
  }
}

function normalizeEndpoint(value: string): string {
  const url = new URL(String(value || '').trim())
  if (url.username || url.password) throw new Error('WebDAV 地址中不要包含用户名或密码')
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !localHttp) throw new Error('为防止密码泄露，WebDAV 必须使用 HTTPS（本机地址除外）')
  url.hash = ''
  url.search = ''
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.toString()
}

function normalizeRemotePath(value: string): string {
  const segments = String(value || 'CipherTalk/todos.enc.json')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) throw new Error('同步文件路径无效')
  const normalized = segments.join('/')
  if (normalized.length > 500) throw new Error('同步文件路径过长')
  return normalized
}

function remoteUrl(config: TodoStoredSyncConfig, path = config.remotePath, collection = false): string {
  const encoded = path.split('/').filter(Boolean).map(encodeURIComponent).join('/')
  return new URL(`${encoded}${collection ? '/' : ''}`, config.endpoint).toString()
}

function decryptStored(value: string, label: string): string {
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  } catch {
    throw new Error(`${label}无法从系统安全存储中读取，请重新配置同步`)
  }
}

function buildLocalDocument(config: ConfigService, stored: TodoStoredSyncConfig): TodoSyncDocument {
  const settings = config.get('todoSettings')
  const document = createEmptyTodoSyncDocument(stored.deviceId, {
    reminderEnabled: settings.reminderEnabled,
    remindBeforeMinutes: settings.remindBeforeMinutes,
    includeSourcePreview: stored.includeSourcePreview,
  })
  document.revision = stored.localRevision
  document.updatedAt = stored.lastLocalChangeAt || Date.now()
  document.items = (config.get('todoItems') || []).map((item) => redactTodoForSync(item, stored.includeSourcePreview))
  document.tombstones = config.get('todoTombstones') || []
  return document
}

export function markTodoSyncDirty(config: ConfigService): void {
  const current = config.get('todoSyncConfig')
  config.set('todoSyncConfig', {
    ...current,
    localRevision: Math.max(0, current.localRevision || 0) + 1,
    lastLocalChangeAt: Date.now(),
  })
}

export class TodoSyncService {
  private syncPromise: Promise<TodoSyncResult> | null = null
  private timer: NodeJS.Timeout | null = null

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), SYNC_INTERVAL_MS)
    this.timer.unref?.()
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  getState(): TodoSyncState {
    const config = new ConfigService()
    try {
      return publicState(config.get('todoSyncConfig'), Boolean(this.syncPromise))
    } finally {
      config.close()
    }
  }

  configure(input: TodoSyncConfigInput): TodoSyncResult {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，不会以明文保存同步凭据')
    const config = new ConfigService()
    try {
      const current = config.get('todoSyncConfig')
      const endpoint = normalizeEndpoint(input.endpoint)
      const username = String(input.username || '').trim().slice(0, 254)
      const password = String(input.password || '')
      const suppliedSecret = String(input.secret || '').trim()
      if (!username) throw new Error('WebDAV 用户名不能为空')
      if (!password && !current.encryptedPassword) throw new Error('首次配置需要填写 WebDAV 密码或应用专用密码')
      if (suppliedSecret && suppliedSecret.length < 12) throw new Error('同步恢复密钥至少需要 12 个字符')

      const generatedSecret = suppliedSecret || current.encryptedSecret ? undefined : generateTodoSyncSecret()
      const next: TodoStoredSyncConfig = {
        ...current,
        enabled: input.enabled !== false,
        endpoint,
        username,
        remotePath: normalizeRemotePath(input.remotePath || current.remotePath),
        autoSync: input.autoSync !== false,
        includeSourcePreview: input.includeSourcePreview === true,
        deviceId: current.deviceId || randomUUID(),
        lastError: '',
        encryptedPassword: password ? safeStorage.encryptString(password).toString('base64') : current.encryptedPassword,
        encryptedSecret: suppliedSecret || generatedSecret
          ? safeStorage.encryptString(suppliedSecret || generatedSecret || '').toString('base64')
          : current.encryptedSecret,
        etag: endpoint === current.endpoint && (input.remotePath || current.remotePath) === current.remotePath ? current.etag : '',
      }
      config.set('todoSyncConfig', next)
      return { success: true, state: publicState(next, false), generatedSecret }
    } finally {
      config.close()
    }
  }

  disconnect(): TodoSyncState {
    const config = new ConfigService()
    try {
      const current = config.get('todoSyncConfig')
      const next: TodoStoredSyncConfig = {
        ...current,
        enabled: false,
        endpoint: '',
        username: '',
        encryptedPassword: '',
        encryptedSecret: '',
        etag: '',
        lastSyncAt: 0,
        lastError: '',
      }
      config.set('todoSyncConfig', next)
      return publicState(next, false)
    } finally {
      config.close()
    }
  }

  syncNow(): Promise<TodoSyncResult> {
    if (this.syncPromise) return this.syncPromise
    this.syncPromise = this.performSync(0).finally(() => {
      this.syncPromise = null
    })
    return this.syncPromise
  }

  private async request(config: TodoStoredSyncConfig, password: string, path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    timeout.unref?.()
    try {
      const authorization = Buffer.from(`${config.username}:${password}`, 'utf8').toString('base64')
      const response = await net.fetch(path, {
        ...init,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Authorization: `Basic ${authorization}`,
          ...(init.headers || {}),
        },
      })
      if (response.status >= 300 && response.status < 400) throw new Error('WebDAV 地址发生重定向，请填写重定向后的最终 HTTPS 地址')
      return response
    } finally {
      clearTimeout(timeout)
    }
  }

  private async ensureCollections(config: TodoStoredSyncConfig, password: string): Promise<void> {
    const directories = config.remotePath.split('/').slice(0, -1)
    for (let index = 1; index <= directories.length; index += 1) {
      const response = await this.request(config, password, remoteUrl(config, directories.slice(0, index).join('/'), true), { method: 'MKCOL' })
      if (![201, 204, 405].includes(response.status)) {
        throw new Error(`无法创建 WebDAV 目录（HTTP ${response.status}）`)
      }
    }
  }

  private async performSync(retry: number): Promise<TodoSyncResult> {
    const config = new ConfigService()
    let stored = config.get('todoSyncConfig')
    try {
      const state = publicState(stored, true)
      if (!state.configured || !stored.enabled) throw new Error('请先配置并启用 WebDAV 同步')
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用')
      const password = decryptStored(stored.encryptedPassword, 'WebDAV 密码')
      const secret = decryptStored(stored.encryptedSecret, '同步恢复密钥')
      const local = buildLocalDocument(config, stored)
      const target = remoteUrl(stored)

      const getResponse = await this.request(stored, password, target, { method: 'GET', headers: { Accept: 'application/json' } })
      let remote = createEmptyTodoSyncDocument(stored.deviceId, local.preferences)
      let etag = ''
      if (getResponse.status === 200) {
        const text = await getResponse.text()
        if (text.length > 5_000_000) throw new Error('远端同步文件异常过大')
        remote = await decryptTodoSyncEnvelope(JSON.parse(text) as TodoSyncEnvelope, secret)
        etag = getResponse.headers.get('etag') || ''
      } else if (getResponse.status !== 404) {
        throw new Error(`读取 WebDAV 同步文件失败（HTTP ${getResponse.status}）`)
      }

      const merged = mergeTodoSyncDocuments(local, remote, stored.deviceId)
      // 远端默认不含消息摘要；合并回本机时保留本机已有的私有摘要。
      const localById = new Map((config.get('todoItems') || []).map((item) => [item.id, item]))
      merged.items = merged.items.map((item) => item.sourcePreview ? item : {
        ...item,
        sourcePreview: localById.get(item.id)?.sourcePreview || '',
      })
      const uploadDocument: TodoSyncDocument = {
        ...merged,
        items: merged.items.map((item) => redactTodoForSync(item, merged.preferences.includeSourcePreview)),
      }
      const envelope = await encryptTodoSyncDocument(uploadDocument, secret)
      if (getResponse.status === 404) await this.ensureCollections(stored, password)
      const putResponse = await this.request(stored, password, target, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/vnd.ciphertalk.todo-sync+json',
          ...(etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }),
        },
        body: JSON.stringify(envelope),
      })
      if (putResponse.status === 412 && retry < 2) {
        config.close()
        return this.performSync(retry + 1)
      }
      if (![200, 201, 204].includes(putResponse.status)) throw new Error(`写入 WebDAV 同步文件失败（HTTP ${putResponse.status}）`)

      // 若同步期间本机发生了修改，再走一轮拉取合并，避免异步网络请求覆盖新任务。
      const latestStored = config.get('todoSyncConfig')
      if (latestStored.localRevision !== stored.localRevision) {
        if (retry >= 2) throw new Error('同步期间本机持续发生修改，本机数据已保留，请稍后重试同步')
        config.set('todoSyncConfig', { ...latestStored, etag: putResponse.headers.get('etag') || '' })
        config.close()
        return this.performSync(retry + 1)
      }

      const settings = config.get('todoSettings')
      config.set('todoItems', merged.items)
      config.set('todoTombstones', merged.tombstones)
      config.set('todoSettings', {
        ...settings,
        reminderEnabled: merged.preferences.reminderEnabled,
        remindBeforeMinutes: merged.preferences.remindBeforeMinutes,
      })
      const syncedAt = Date.now()
      stored = {
        ...latestStored,
        includeSourcePreview: merged.preferences.includeSourcePreview,
        etag: putResponse.headers.get('etag') || etag,
        localRevision: merged.revision,
        lastLocalChangeAt: merged.updatedAt,
        lastSyncAt: syncedAt,
        lastError: '',
      }
      config.set('todoSyncConfig', stored)
      return { success: true, state: publicState(stored, false), mergedItems: merged.items.length }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      stored = { ...stored, lastError: message }
      config.set('todoSyncConfig', stored)
      return { success: false, state: publicState(stored, false), error: message }
    } finally {
      config.close()
    }
  }

  private async tick(): Promise<void> {
    if (this.syncPromise) return
    const config = new ConfigService()
    try {
      const stored = config.get('todoSyncConfig')
      if (!stored.enabled || !stored.autoSync || !publicState(stored, false).configured) return
      const localChanged = stored.lastLocalChangeAt > stored.lastSyncAt
      const remotePollDue = Date.now() - stored.lastSyncAt >= REMOTE_POLL_MS
      if (localChanged || remotePollDue) void this.syncNow()
    } finally {
      config.close()
    }
  }
}

export const todoSyncService = new TodoSyncService()
