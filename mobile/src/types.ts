export interface MobileSyncConfig {
  endpoint: string
  username: string
  remotePath: string
  deviceId: string
  lastSyncAt: number
  lastError: string
  remindBeforeMinutes: number
  wallpaperAuto: boolean
}

export interface MobileCredentials {
  password: string
  secret: string
}
