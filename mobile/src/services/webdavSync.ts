import { CapacitorHttp } from '@capacitor/core'
import {
  createEmptyTodoSyncDocument,
  decryptTodoSyncEnvelope,
  encryptTodoSyncDocument,
  mergeTodoSyncDocuments,
  redactTodoForSync,
} from '@shared/todoSync'
import type { TodoSyncDocument, TodoSyncEnvelope } from '../../../src/types/todo'
import type { MobileCredentials, MobileSyncConfig } from '../types'

function base64Utf8(value: string): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function normalizeMobileEndpoint(value: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('请输入完整的 WebDAV 地址，例如 https://dav.example.com/dav/') }
  if (url.username || url.password) throw new Error('WebDAV 地址中不要包含用户名或密码')
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !localHttp) throw new Error('WebDAV 必须使用 HTTPS')
  url.hash = ''
  url.search = ''
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.toString()
}

export function normalizeMobileRemotePath(value: string): string {
  const parts = value.replace(/\\/g, '/').split('/').filter(Boolean)
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) throw new Error('远端路径无效')
  return parts.join('/')
}

function remoteUrl(config: MobileSyncConfig, path = config.remotePath, directory = false): string {
  const encoded = path.split('/').filter(Boolean).map(encodeURIComponent).join('/')
  return new URL(`${encoded}${directory ? '/' : ''}`, config.endpoint).toString()
}

function header(headers: Record<string, string>, name: string): string {
  const match = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase())
  return match?.[1] || ''
}

async function request(
  config: MobileSyncConfig,
  credentials: MobileCredentials,
  url: string,
  method: string,
  headers: Record<string, string> = {},
  data?: string,
) {
  try { return await CapacitorHttp.request({
    url,
    method,
    headers: {
      Authorization: `Basic ${base64Utf8(`${config.username}:${credentials.password}`)}`,
      ...headers,
    },
    data,
    responseType: 'text',
    connectTimeout: 30_000,
    readTimeout: 30_000,
    disableRedirects: true,
  }) } catch {
    // Native networking errors can contain request details. Keep credentials out of UI and persisted errors.
    throw new Error('无法连接 WebDAV，请检查网络和服务器地址后重试')
  }
}

function responseError(status: number, operation: string): Error {
  if (status === 401 || status === 403) return new Error('WebDAV 拒绝访问，请核对用户名、应用专用密码和文件权限')
  if (status >= 300 && status < 400) return new Error('WebDAV 地址发生跳转，请填写服务商提供的最终 HTTPS 地址')
  if (status === 429) return new Error('同步请求过于频繁，请稍后重试')
  if (status >= 500) return new Error('WebDAV 服务暂时不可用，请稍后重试')
  if (status === 412) return new Error('其他设备正在更新，请稍后再次同步')
  return new Error(`${operation}失败（HTTP ${status}）`)
}

async function ensureCollections(config: MobileSyncConfig, credentials: MobileCredentials): Promise<void> {
  const directories = config.remotePath.split('/').slice(0, -1)
  for (let index = 1; index <= directories.length; index += 1) {
    const response = await request(config, credentials, remoteUrl(config, directories.slice(0, index).join('/'), true), 'MKCOL')
    if (![201, 204, 405].includes(response.status)) throw responseError(response.status, '创建远端目录')
  }
}

export async function syncWithWebDav(
  config: MobileSyncConfig,
  credentials: MobileCredentials,
  local: TodoSyncDocument,
  options: { requireExisting?: boolean } = {},
  retry = 0,
): Promise<{ config: MobileSyncConfig; document: TodoSyncDocument }> {
  const target = remoteUrl(config)
  const getResponse = await request(config, credentials, target, 'GET', { Accept: 'application/json' })
  let remote = createEmptyTodoSyncDocument(config.deviceId, local.preferences)
  let etag = ''
  if (getResponse.status === 200) {
    const raw = typeof getResponse.data === 'string' ? getResponse.data : JSON.stringify(getResponse.data)
    if (raw.length > 5_000_000) throw new Error('远端同步文件异常过大')
    let envelope: TodoSyncEnvelope
    try { envelope = JSON.parse(raw) as TodoSyncEnvelope } catch { throw new Error('远端文件不是有效的同步文档，请核对文件路径') }
    try { remote = await decryptTodoSyncEnvelope(envelope, credentials.secret) } catch {
      throw new Error('无法解密同步文档，请核对电脑端的同步恢复密钥和文件路径')
    }
    etag = header(getResponse.headers, 'etag')
  } else if (getResponse.status === 404 && options.requireExisting) {
    throw new Error('未找到电脑端的同步文件。请先在电脑端成功同步一次，并核对远端文件路径')
  } else if (getResponse.status !== 404) {
    throw responseError(getResponse.status, '读取 WebDAV')
  }

  const merged = mergeTodoSyncDocuments(local, remote, config.deviceId)
  const upload: TodoSyncDocument = {
    ...merged,
    items: merged.items.map((item) => redactTodoForSync(item, merged.preferences.includeSourcePreview)),
  }
  const envelope = await encryptTodoSyncDocument(upload, credentials.secret)
  if (getResponse.status === 404) await ensureCollections(config, credentials)
  const putResponse = await request(config, credentials, target, 'PUT', {
    'Content-Type': 'application/vnd.ciphertalk.todo-sync+json',
    ...(etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }),
  }, JSON.stringify(envelope))
  if (putResponse.status === 412 && retry < 2) return syncWithWebDav(config, credentials, local, options, retry + 1)
  if (![200, 201, 204].includes(putResponse.status)) throw responseError(putResponse.status, '写入 WebDAV')
  return {
    config: { ...config, lastSyncAt: Date.now(), lastError: '' },
    document: merged,
  }
}
