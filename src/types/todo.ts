export type TodoSourceType = 'wechat' | 'gmail' | 'imap' | 'drive' | 'manual'

export type TodoPriority = 'high' | 'medium' | 'low'

export type TodoStatus = 'pending' | 'completed' | 'dismissed'

export type TodoFeedback = 'useful' | 'not-useful'

/** `useless` is the desktop UI label; stored/synced feedback stays `not-useful`. */
export type TodoFeedbackVote = TodoFeedback | 'useless' | null

export interface TodoProfile {
  summary: string
  roles: string[]
  usefulCount: number
  uselessCount: number
}

export interface TodoInsight {
  kind: 'action' | 'information'
  score: number
  baseScore: number
  adjustment: number
  reason: string
  topics: string[]
}

export interface TodoItem {
  id: string
  title: string
  details: string
  dueAt: string | null
  /** Source event end; absent for tasks without an explicit duration. */
  endAt?: string | null
  /** Original message timestamp in seconds, never the extraction timestamp. */
  sourceCreatedAt?: number
  priority: TodoPriority
  status: TodoStatus
  sourceType: TodoSourceType
  sourceLabel: string
  sourceRef: string
  sourcePreview: string
  confidence: number
  createdAt: number
  updatedAt: number
  remindedAt?: number
  insight?: TodoInsight
  feedback?: TodoFeedback | null
  feedbackAt?: number
  feedbackPreviousStatus?: TodoStatus
  evidence?: TodoEvidence
}

export interface TodoEvidence {
  engine: 'laya' | 'jev' | 'llm'
  messageQuote: string
  dateQuote?: string
  date?: string
  /** Zone used to resolve source time; absent from older records. */
  timeZone?: string
  dateStatus: 'exact' | 'date-only' | 'unconfirmed' | 'none' | 'user-confirmed'
  needsReview: boolean
  /** The classifier's reported confidence, not a calibrated accuracy guarantee. */
  decisionConfidence?: number
}

export interface TodoConnector {
  id: string
  type: Exclude<TodoSourceType, 'manual' | 'drive'>
  name: string
  account?: string
  enabled: boolean
  status: 'connected' | 'needs-setup' | 'error'
  lastSyncAt?: number
  error?: string
}

export type TodoMailProvider = 'gmail' | 'outlook' | 'icloud' | 'yahoo' | 'qq' | '163' | 'custom'

export interface TodoMailAccount {
  id: string
  provider: TodoMailProvider
  name: string
  email: string
  host: string
  port: number
  secure: boolean
  enabled: boolean
  lastSyncAt?: number
  error?: string
}

export interface TodoStoredMailAccount extends TodoMailAccount {
  encryptedPassword: string
}

export interface TodoMailAccountInput {
  provider: TodoMailProvider
  name?: string
  email: string
  host: string
  port?: number
  secure?: boolean
  password: string
}

export interface TodoMailViewerMessage {
  id: string
  accountId: string
  provider: TodoMailProvider | 'google-oauth'
  subject: string
  from: string
  to: string
  receivedAt: number
  snippet: string
  body: string
  hasAttachments: boolean
}

export interface TodoMailInboxResult {
  success: boolean
  accountLabel?: string
  messages?: TodoMailViewerMessage[]
  error?: string
}

export interface TodoGoogleConnectionState {
  configured: boolean
  connected: boolean
  email: string
  clientId: string
  scopes: string[]
  lastSyncAt: number
  lastError: string
}

export interface TodoGoogleConnectInput {
  clientId: string
  clientSecret?: string
}

export interface TodoStoredGoogleConfig {
  enabled: boolean
  clientId: string
  encryptedClientSecret: string
  encryptedAccessToken: string
  encryptedRefreshToken: string
  accessTokenExpiresAt: number
  email: string
  scopes: string[]
  lastSyncAt: number
  lastError: string
}

export interface TodoScanState {
  lastScanAt: number
  lastSuccessfulScanAt: number
  lastAutoScanDay: string
  processedFingerprints: string[]
  analyzedMessages: number
  extractedTodos: number
  lastError: string
  /** Optional for stores written before scan usage was recorded. */
  lastCacheHits?: number
  lastSentMessages?: number
  lastInputTokens?: number
  lastOutputTokens?: number
  /** A local estimate using the selected model's price; absent when unavailable. */
  lastEstimatedCostUsd?: number
  lastDecisionEngine?: 'laya' | 'jev' | 'llm'
  lastDecisionRequests?: number
  lastRuleSkipped?: number
  lastReviewItems?: number
}

export interface TodoSettings {
  personalContext?: string
  learningEnabled?: boolean
  autoScanEnabled: boolean
  scanHour: number
  reminderEnabled: boolean
  remindBeforeMinutes: number
  wallpaperEnabled: boolean
  connectors: TodoConnector[]
}

export interface TodoDashboardState {
  items: TodoItem[]
  scan: TodoScanState
  settings: TodoSettings
  mailAccounts: TodoMailAccount[]
  google: TodoGoogleConnectionState
  sync: TodoSyncState
  aiConfigured: boolean
  scanning: boolean
  profile?: TodoProfile
}

export interface TodoScanResult {
  success: boolean
  partial?: boolean
  skipped?: boolean
  reason?: string
  scannedMessages?: number
  analyzedMessages?: number
  addedTodos?: number
  items?: TodoItem[]
  error?: string
}

export interface TodoCreateInput {
  title: string
  details?: string
  dueAt?: string | null
  priority?: TodoPriority
  sourceType?: TodoSourceType
  sourceLabel?: string
  sourceRef?: string
  sourcePreview?: string
  confidence?: number
}

export interface TodoUpdateInput {
  feedback?: TodoFeedback | null
  title?: string
  details?: string
  dueAt?: string | null
  priority?: TodoPriority
  status?: TodoStatus
}

export interface TodoTombstone {
  id: string
  deletedAt: number
  deviceId: string
}

export interface TodoSyncPreferences {
  reminderEnabled: boolean
  remindBeforeMinutes: number
  includeSourcePreview: boolean
}

export interface TodoSyncDocument {
  schemaVersion: 1
  deviceId: string
  revision: number
  updatedAt: number
  items: TodoItem[]
  tombstones: TodoTombstone[]
  preferences: TodoSyncPreferences
}

export interface TodoSyncEnvelope {
  format: 'ciphertalk-todo-sync'
  version: 1
  kdf: {
    name: 'PBKDF2-SHA-256'
    iterations: number
    salt: string
  }
  cipher: {
    name: 'AES-256-GCM'
    iv: string
    ciphertext: string
  }
  createdAt: number
}

export interface TodoSyncState {
  configured: boolean
  enabled: boolean
  endpoint: string
  username: string
  remotePath: string
  autoSync: boolean
  includeSourcePreview: boolean
  deviceId: string
  lastSyncAt: number
  lastError: string
  syncing: boolean
}

export interface TodoSyncConfigInput {
  endpoint: string
  username: string
  password?: string
  remotePath?: string
  secret?: string
  autoSync?: boolean
  includeSourcePreview?: boolean
  enabled?: boolean
}

export interface TodoStoredSyncConfig extends Omit<TodoSyncState, 'configured' | 'syncing'> {
  encryptedPassword: string
  encryptedSecret: string
  etag: string
  localRevision: number
  lastLocalChangeAt: number
}

export interface TodoSyncResult {
  success: boolean
  state?: TodoSyncState
  generatedSecret?: string
  mergedItems?: number
  error?: string
}
