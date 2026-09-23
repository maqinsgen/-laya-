import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import { Preferences } from '@capacitor/preferences'
import { createEmptyTodoSyncDocument, decryptTodoSyncEnvelope, encryptTodoSyncDocument } from '@shared/todoSync'
import type { TodoSyncDocument, TodoSyncEnvelope } from '../../../src/types/todo'
import type { MobileCredentials, MobileSyncConfig } from '../types'

const CONFIG_KEY = 'ciphertalk.todo.mobile.config.v1'
const DOCUMENT_KEY = 'ciphertalk.todo.mobile.document.v1'
const PASSWORD_KEY = 'webdav-password'
const SECRET_KEY = 'sync-secret'
let secureReady = false

async function prepareSecureStorage(): Promise<void> {
  if (secureReady) return
  await SecureStorage.setKeyPrefix('ciphertalk-todo_')
  secureReady = true
}

export async function loadMobileConfig(): Promise<MobileSyncConfig | null> {
  const { value } = await Preferences.get({ key: CONFIG_KEY })
  if (!value) return null
  const parsed = JSON.parse(value) as MobileSyncConfig
  return { ...parsed, wallpaperAuto: parsed.wallpaperAuto === true }
}

export async function saveMobileConfig(config: MobileSyncConfig): Promise<void> {
  await Preferences.set({ key: CONFIG_KEY, value: JSON.stringify(config) })
}

export async function saveCredentials(credentials: MobileCredentials): Promise<void> {
  await prepareSecureStorage()
  await SecureStorage.setItem(PASSWORD_KEY, credentials.password)
  await SecureStorage.setItem(SECRET_KEY, credentials.secret)
}

export async function loadCredentials(): Promise<MobileCredentials | null> {
  await prepareSecureStorage()
  const [password, secret] = await Promise.all([
    SecureStorage.getItem(PASSWORD_KEY),
    SecureStorage.getItem(SECRET_KEY),
  ])
  return password && secret ? { password, secret } : null
}

export async function loadLocalDocument(config: MobileSyncConfig, secret: string): Promise<TodoSyncDocument> {
  const { value } = await Preferences.get({ key: DOCUMENT_KEY })
  if (!value) return createEmptyTodoSyncDocument(config.deviceId)
  return decryptTodoSyncEnvelope(JSON.parse(value) as TodoSyncEnvelope, secret)
}

export async function saveLocalDocument(document: TodoSyncDocument, secret: string): Promise<void> {
  const envelope = await encryptTodoSyncDocument(document, secret)
  await Preferences.set({ key: DOCUMENT_KEY, value: JSON.stringify(envelope) })
}

/** Keep a failed connection change from leaving the existing cache paired with a different key. */
export async function saveMobileConnection(config: MobileSyncConfig, credentials: MobileCredentials, document: TodoSyncDocument): Promise<void> {
  await prepareSecureStorage()
  const [previousConfig, previousDocument, previousPassword, previousSecret] = await Promise.all([
    Preferences.get({ key: CONFIG_KEY }),
    Preferences.get({ key: DOCUMENT_KEY }),
    SecureStorage.getItem(PASSWORD_KEY),
    SecureStorage.getItem(SECRET_KEY),
  ])
  try {
    await saveCredentials(credentials)
    await saveLocalDocument(document, credentials.secret)
    await saveMobileConfig(config)
  } catch {
    const rollback = await Promise.allSettled([
      previousConfig.value === null ? Preferences.remove({ key: CONFIG_KEY }) : Preferences.set({ key: CONFIG_KEY, value: previousConfig.value }),
      previousDocument.value === null ? Preferences.remove({ key: DOCUMENT_KEY }) : Preferences.set({ key: DOCUMENT_KEY, value: previousDocument.value }),
      previousPassword === null ? SecureStorage.removeItem(PASSWORD_KEY) : SecureStorage.setItem(PASSWORD_KEY, previousPassword),
      previousSecret === null ? SecureStorage.removeItem(SECRET_KEY) : SecureStorage.setItem(SECRET_KEY, previousSecret),
    ])
    if (rollback.some((entry) => entry.status === 'rejected')) throw new Error('本机安全存储无法保存配置，请保持此页面，检查系统存储空间后重试')
    throw new Error('本机未能保存新连接，已恢复原配置。请检查系统存储空间后重试')
  }
}

export async function clearMobileStorage(): Promise<void> {
  await prepareSecureStorage()
  await Promise.all([
    Preferences.remove({ key: CONFIG_KEY }),
    Preferences.remove({ key: DOCUMENT_KEY }),
    SecureStorage.removeItem(PASSWORD_KEY),
    SecureStorage.removeItem(SECRET_KEY),
  ])
}
