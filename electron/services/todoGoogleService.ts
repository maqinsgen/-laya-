import { createHash, randomBytes } from 'crypto'
import * as http from 'http'
import { net, safeStorage, shell } from 'electron'
import { ConfigService } from './config'
import { extractGoogleDriveReferences } from '../../src/shared/googleTodo'
import { htmlMailToPlainText, normalizeMailBody } from '../../src/shared/mailText'
import type {
  TodoGoogleConnectInput,
  TodoGoogleConnectionState,
  TodoMailViewerMessage,
  TodoStoredGoogleConfig,
} from '../../src/types/todo'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_GMAIL_API = 'https://gmail.googleapis.com/gmail/v1'
const GOOGLE_DRIVE_API = 'https://www.googleapis.com/drive/v3'
const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
]
const OAUTH_TIMEOUT_MS = 5 * 60_000
const GOOGLE_REQUEST_TIMEOUT_MS = 30_000
const MAX_GOOGLE_MESSAGES = 100
const MAX_DRIVE_LINKS = 20

export interface TodoGoogleScanMessage {
  key: string
  fingerprint: string
  sessionId: string
  sourceLabel: string
  createTime: number
  text: string
  sourceType: 'gmail' | 'drive'
  sourceRef: string
  direction: 'incoming' | 'outgoing' | 'unknown'
  senderLabel: string
}

interface GoogleTokenResponse {
  access_token?: string
  expires_in?: number
  refresh_token?: string
  scope?: string
  error?: string
  error_description?: string
}

interface GmailPart {
  mimeType?: string
  filename?: string
  body?: { data?: string }
  parts?: GmailPart[]
}

interface GmailMessage {
  id?: string
  internalDate?: string
  snippet?: string
  payload?: GmailPart & { headers?: Array<{ name?: string; value?: string }> }
}

interface DriveFile {
  id?: string
  name?: string
  mimeType?: string
  modifiedTime?: string
  webViewLink?: string
  description?: string
  size?: string
}

function normalize(value: unknown, max = 1_000): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function base64Url(value: Buffer): string {
  return value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decrypt(value: string): string {
  if (!value) return ''
  return safeStorage.decryptString(Buffer.from(value, 'base64'))
}

function encrypt(value: string): string {
  return value ? safeStorage.encryptString(value).toString('base64') : ''
}

function decodeGmailData(value: string): string {
  if (!value) return ''
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(normalized, 'base64').toString('utf8')
}

function gmailBody(part?: GmailPart): string {
  if (!part) return ''
  const plain: string[] = []
  const html: string[] = []
  const visit = (current: GmailPart): void => {
    const data = current.body?.data ? decodeGmailData(current.body.data) : ''
    if (data && current.mimeType === 'text/plain') plain.push(data)
    else if (data && current.mimeType === 'text/html') html.push(htmlMailToPlainText(data))
    for (const child of current.parts || []) visit(child)
  }
  visit(part)
  return normalizeMailBody((plain.length ? plain : html).join('\n'), 3_000)
}

function gmailHeader(message: GmailMessage, name: string): string {
  return normalize(message.payload?.headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value, 300)
}

function gmailHasAttachments(part?: GmailPart): boolean {
  if (!part) return false
  if (Boolean(part.filename)) return true
  return (part.parts || []).some((child) => gmailHasAttachments(child))
}

function publicState(config: TodoStoredGoogleConfig): TodoGoogleConnectionState {
  return {
    configured: Boolean(config.clientId),
    connected: Boolean(config.enabled && config.encryptedRefreshToken),
    email: config.email,
    clientId: config.clientId,
    scopes: [...config.scopes],
    lastSyncAt: config.lastSyncAt,
    lastError: config.lastError,
  }
}

export class TodoGoogleService {
  private connectPromise: Promise<TodoGoogleConnectionState> | null = null

  getState(): TodoGoogleConnectionState {
    const config = new ConfigService()
    try {
      return publicState(config.get('todoGoogleConfig'))
    } finally {
      config.close()
    }
  }

  async listInbox(limit = 30): Promise<TodoMailViewerMessage[]> {
    const stored = this.readStoredConfig()
    if (!stored.enabled || !stored.encryptedRefreshToken) throw new Error('Google 尚未连接')
    const safeLimit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 30)))
    try {
      const accessToken = await this.getAccessToken()
      const query = new URLSearchParams({ labelIds: 'INBOX', maxResults: String(safeLimit) })
      const listing = await this.googleJson<{ messages?: Array<{ id?: string }> }>(`${GOOGLE_GMAIL_API}/users/me/messages?${query}`, accessToken)
      const ids = (listing.messages || []).map((entry) => entry.id).filter((id): id is string => Boolean(id))
      const messages: TodoMailViewerMessage[] = []
      for (let cursor = 0; cursor < ids.length; cursor += 8) {
        const chunk = ids.slice(cursor, cursor + 8)
        const details = await Promise.all(chunk.map((id) => this.googleJson<GmailMessage>(`${GOOGLE_GMAIL_API}/users/me/messages/${encodeURIComponent(id)}?format=full`, accessToken)))
        for (const message of details) {
          if (!message.id) continue
          const body = gmailBody(message.payload) || normalize(message.snippet, 1_500)
          messages.push({
            id: message.id,
            accountId: 'google-oauth',
            provider: 'google-oauth',
            subject: gmailHeader(message, 'subject') || '无主题',
            from: gmailHeader(message, 'from'),
            to: gmailHeader(message, 'to'),
            receivedAt: Number(message.internalDate || 0) || Date.now(),
            snippet: normalize(message.snippet || body, 300),
            body: normalizeMailBody(body, 20_000),
            hasAttachments: gmailHasAttachments(message.payload),
          })
        }
      }
      this.updateSyncState({ lastSyncAt: Date.now(), lastError: '' })
      return messages.sort((a, b) => b.receivedAt - a.receivedAt)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.updateSyncState({ lastError: message })
      throw new Error(message)
    }
  }

  connect(input: TodoGoogleConnectInput): Promise<TodoGoogleConnectionState> {
    if (this.connectPromise) return this.connectPromise
    this.connectPromise = this.performConnect(input).finally(() => {
      this.connectPromise = null
    })
    return this.connectPromise
  }

  disconnect(): TodoGoogleConnectionState {
    const config = new ConfigService()
    try {
      const current = config.get('todoGoogleConfig')
      const next: TodoStoredGoogleConfig = {
        ...current,
        enabled: false,
        encryptedAccessToken: '',
        encryptedRefreshToken: '',
        accessTokenExpiresAt: 0,
        email: '',
        scopes: [],
        lastSyncAt: 0,
        lastError: '',
      }
      config.set('todoGoogleConfig', next)
      return publicState(next)
    } finally {
      config.close()
    }
  }

  async collectGmailMessages(sinceSeconds: number, processed: Set<string>): Promise<TodoGoogleScanMessage[]> {
    const config = new ConfigService()
    const stored = config.get('todoGoogleConfig')
    config.close()
    if (!stored.enabled || !stored.encryptedRefreshToken) return []

    try {
      const accessToken = await this.getAccessToken()
      const query = new URLSearchParams({ q: `after:${sinceSeconds}`, maxResults: String(MAX_GOOGLE_MESSAGES), includeSpamTrash: 'false' })
      const listing = await this.googleJson<{ messages?: Array<{ id?: string }> }>(`${GOOGLE_GMAIL_API}/users/me/messages?${query}`, accessToken)
      const ids = (listing.messages || []).map((entry) => entry.id).filter((id): id is string => Boolean(id))
      const messages: TodoGoogleScanMessage[] = []

      for (let cursor = 0; cursor < ids.length; cursor += 8) {
        const chunk = ids.slice(cursor, cursor + 8)
        const details = await Promise.all(chunk.map((id) => this.googleJson<GmailMessage>(`${GOOGLE_GMAIL_API}/users/me/messages/${encodeURIComponent(id)}?format=full`, accessToken)))
        for (const message of details) {
          if (!message.id) continue
          const createdAt = Math.floor(Number(message.internalDate || 0) / 1000)
          if (createdAt && createdAt < sinceSeconds) continue
          const itemFingerprint = fingerprint(`google:gmail:${message.id}`)
          if (processed.has(itemFingerprint)) continue
          const subject = gmailHeader(message, 'subject') || '无主题'
          const from = gmailHeader(message, 'from')
          const outgoing = Boolean(stored.email && from.toLowerCase().includes(stored.email.toLowerCase()))
          const body = gmailBody(message.payload) || normalize(message.snippet, 1_500)
          messages.push({
            key: itemFingerprint.slice(0, 16),
            fingerprint: itemFingerprint,
            sessionId: 'google:gmail',
            sourceLabel: `Gmail · ${subject}`,
            createTime: createdAt || Math.floor(Date.now() / 1000),
            text: normalize(`主题：${subject}\n发件人：${from}\n正文：${body}`, 3_500),
            sourceType: 'gmail',
            sourceRef: `gmail:google-oauth:${message.id}`,
            direction: outgoing ? 'outgoing' : 'incoming',
            senderLabel: outgoing ? '用户本人' : (from || 'Gmail 发件人'),
          })
        }
      }
      this.updateSyncState({ lastSyncAt: Date.now(), lastError: '' })
      return messages
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.updateSyncState({ lastError: message })
      throw new Error(`Gmail 读取失败：${message}`)
    }
  }

  async collectDriveMessages(
    sourceMessages: Array<{ text: string; createTime: number; direction?: 'incoming' | 'outgoing' | 'unknown'; senderLabel?: string }>,
    processed: Set<string>,
  ): Promise<TodoGoogleScanMessage[]> {
    const config = new ConfigService()
    const stored = config.get('todoGoogleConfig')
    config.close()
    if (!stored.enabled || !stored.encryptedRefreshToken) return []

    const references = new Map<string, { url: string; context: string; createTime: number; direction: 'incoming' | 'outgoing' | 'unknown'; senderLabel: string }>()
    for (const message of sourceMessages) {
      for (const reference of extractGoogleDriveReferences(message.text)) {
        if (references.size >= MAX_DRIVE_LINKS) break
        if (!references.has(reference.id)) references.set(reference.id, {
          url: reference.url,
          context: message.text,
          createTime: message.createTime,
          direction: message.direction || 'unknown',
          senderLabel: message.senderLabel || '链接所在消息',
        })
      }
    }
    if (!references.size) return []

    try {
      const accessToken = await this.getAccessToken()
      const messages: TodoGoogleScanMessage[] = []
      for (const [id, reference] of references) {
        try {
          const fields = encodeURIComponent('id,name,mimeType,modifiedTime,webViewLink,description,size')
          const file = await this.googleJson<DriveFile>(`${GOOGLE_DRIVE_API}/files/${encodeURIComponent(id)}?fields=${fields}&supportsAllDrives=true`, accessToken)
          const itemFingerprint = fingerprint(`google:drive:${id}:${file.modifiedTime || ''}`)
          if (processed.has(itemFingerprint)) continue
          const content = await this.readDriveText(file, id, accessToken)
          const name = normalize(file.name || '未命名文件', 240)
          messages.push({
            key: itemFingerprint.slice(0, 16),
            fingerprint: itemFingerprint,
            sessionId: `google:drive:${id}`,
            sourceLabel: `Google Drive · ${name}`,
            // 按“链接今天何时出现”排序；文件可能很旧，否则会被今日消息上限误裁掉。
            createTime: reference.createTime,
            text: normalize(`文件：${name}\n说明：${file.description || ''}\n链接所在消息：${reference.context}\n文件内容：${content}`, 4_500),
            sourceType: 'drive',
            sourceRef: file.webViewLink || reference.url,
            direction: reference.direction,
            senderLabel: reference.senderLabel,
          })
        } catch {
          // 无权访问、被删除或不支持导出的单个链接不影响其他消息分析。
        }
      }
      return messages
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.updateSyncState({ lastError: message })
      throw new Error(`Google Drive 读取失败：${message}`)
    }
  }

  private async performConnect(input: TodoGoogleConnectInput): Promise<TodoGoogleConnectionState> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，不会以明文保存 Google 令牌')
    const clientId = normalize(input.clientId, 300)
    const clientSecret = String(input.clientSecret || '').trim()
    if (!clientId || !clientId.endsWith('.apps.googleusercontent.com')) throw new Error('请填写 Google Cloud 中“桌面应用”类型的 OAuth 客户端 ID')

    const verifier = base64Url(randomBytes(64))
    const challenge = base64Url(createHash('sha256').update(verifier).digest())
    const state = base64Url(randomBytes(32))
    const server = http.createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      throw new Error('无法创建 Google 授权的本机回调')
    }
    const redirectUri = `http://127.0.0.1:${address.port}/oauth2/callback`
    const callback = this.waitForCallback(server, state)
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })

    try {
      await shell.openExternal(`${GOOGLE_AUTH_URL}?${params}`)
      const code = await callback
      const token = await this.requestToken({
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      })
      if (!token.access_token || !token.refresh_token) throw new Error('Google 未返回离线刷新令牌，请撤销旧授权后重试')
      const profile = await this.googleJson<{ emailAddress?: string }>(`${GOOGLE_GMAIL_API}/users/me/profile`, token.access_token)
      // about.get 不会列举文件，只用于在保存令牌前确认 Drive API 已启用且 scope 可用。
      await this.googleJson(`${GOOGLE_DRIVE_API}/about?fields=${encodeURIComponent('user(emailAddress)')}`, token.access_token)
      const stored: TodoStoredGoogleConfig = {
        enabled: true,
        clientId,
        encryptedClientSecret: encrypt(clientSecret),
        encryptedAccessToken: encrypt(token.access_token),
        encryptedRefreshToken: encrypt(token.refresh_token),
        accessTokenExpiresAt: Date.now() + Math.max(60, Number(token.expires_in || 3_600)) * 1_000,
        email: normalize(profile.emailAddress, 254),
        scopes: normalize(token.scope, 2_000).split(' ').filter(Boolean),
        lastSyncAt: 0,
        lastError: '',
      }
      const config = new ConfigService()
      try {
        config.set('todoGoogleConfig', stored)
      } finally {
        config.close()
      }
      return publicState(stored)
    } finally {
      server.close()
    }
  }

  private readStoredConfig(): TodoStoredGoogleConfig {
    const config = new ConfigService()
    try {
      return config.get('todoGoogleConfig')
    } finally {
      config.close()
    }
  }

  private waitForCallback(server: http.Server, expectedState: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (action: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        action()
      }
      const timer = setTimeout(() => finish(() => reject(new Error('Google 授权等待超时，请重试'))), OAUTH_TIMEOUT_MS)
      server.on('request', (request, response) => {
        const url = new URL(request.url || '/', 'http://127.0.0.1')
        if (url.pathname !== '/oauth2/callback') {
          response.writeHead(404).end()
          return
        }
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
        const error = url.searchParams.get('error')
        const state = url.searchParams.get('state')
        const code = url.searchParams.get('code')
        if (error || state !== expectedState || !code) {
          response.writeHead(400).end('<main style="font:16px system-ui;padding:48px"><h1>授权未完成</h1><p>请返回 CipherTalk 后重试。</p></main>')
          finish(() => reject(new Error(error === 'access_denied' ? '你取消了 Google 授权' : 'Google 授权响应校验失败')))
          return
        }
        response.writeHead(200).end('<main style="font:16px system-ui;padding:48px"><h1>连接成功</h1><p>可以关闭此页面并返回 CipherTalk。</p></main>')
        finish(() => resolve(code))
      })
    })
  }

  private async requestToken(parameters: Record<string, string>): Promise<GoogleTokenResponse> {
    const response = await net.fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(parameters).toString(),
      signal: AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS),
    })
    const text = await response.text()
    let payload: GoogleTokenResponse
    try {
      payload = JSON.parse(text) as GoogleTokenResponse
    } catch {
      throw new Error(`Google 令牌接口返回异常（HTTP ${response.status}）`)
    }
    if (!response.ok || payload.error) throw new Error(payload.error_description || payload.error || `Google 令牌请求失败（HTTP ${response.status}）`)
    return payload
  }

  private async getAccessToken(forceRefresh = false): Promise<string> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用')
    const config = new ConfigService()
    try {
      const stored = config.get('todoGoogleConfig')
      if (!stored.enabled || !stored.encryptedRefreshToken) throw new Error('Google 尚未连接')
      const current = decrypt(stored.encryptedAccessToken)
      if (!forceRefresh && current && stored.accessTokenExpiresAt > Date.now() + 60_000) return current
      const token = await this.requestToken({
        client_id: stored.clientId,
        ...(stored.encryptedClientSecret ? { client_secret: decrypt(stored.encryptedClientSecret) } : {}),
        refresh_token: decrypt(stored.encryptedRefreshToken),
        grant_type: 'refresh_token',
      })
      if (!token.access_token) throw new Error('Google 未返回访问令牌')
      stored.encryptedAccessToken = encrypt(token.access_token)
      stored.accessTokenExpiresAt = Date.now() + Math.max(60, Number(token.expires_in || 3_600)) * 1_000
      stored.lastError = ''
      if (token.scope) stored.scopes = token.scope.split(' ').filter(Boolean)
      config.set('todoGoogleConfig', stored)
      return token.access_token
    } finally {
      config.close()
    }
  }

  private async googleJson<T>(url: string, accessToken: string, retry = true): Promise<T> {
    const response = await net.fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS),
    })
    if (response.status === 401 && retry) return this.googleJson<T>(url, await this.getAccessToken(true), false)
    if (!response.ok) {
      const detail = normalize(await response.text(), 600)
      throw new Error(`Google API 请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`)
    }
    return response.json() as Promise<T>
  }

  private async readDriveText(file: DriveFile, id: string, accessToken: string): Promise<string> {
    const mimeType = file.mimeType || ''
    let url = ''
    if (mimeType === 'application/vnd.google-apps.document') {
      url = `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent('text/plain')}`
    } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
      url = `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent('text/csv')}`
    } else if (mimeType === 'application/vnd.google-apps.presentation') {
      url = `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent('text/plain')}`
    } else if (mimeType.startsWith('text/') && Number(file.size || 0) <= 500_000) {
      url = `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(id)}?alt=media`
    }
    if (!url) return ''
    let response = await net.fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS),
    })
    if (response.status === 401) {
      response = await net.fetch(url, {
        headers: { Authorization: `Bearer ${await this.getAccessToken(true)}` },
        signal: AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS),
      })
    }
    if (!response.ok) return ''
    return normalize(await response.text(), 4_000)
  }

  private updateSyncState(patch: Pick<TodoStoredGoogleConfig, 'lastError'> & Partial<Pick<TodoStoredGoogleConfig, 'lastSyncAt'>>): void {
    const config = new ConfigService()
    try {
      config.set('todoGoogleConfig', { ...config.get('todoGoogleConfig'), ...patch })
    } finally {
      config.close()
    }
  }
}

export const todoGoogleService = new TodoGoogleService()
