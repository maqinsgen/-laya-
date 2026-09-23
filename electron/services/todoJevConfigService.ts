import { safeStorage } from 'electron'
import { ConfigService } from './config'
import { testTodoJevConnection } from './todoJevService'
import {
  DEFAULT_JEV_ENDPOINT, DEFAULT_JEV_MODEL, DEFAULT_LAYA_ENDPOINT, DEFAULT_LAYA_MODEL,
  normalizeTodoJevEndpoint, todoDecisionRequiresApiKey,
  type TodoJevConfigInput, type TodoJevConfigState, type TodoJevRuntimeConfig, type TodoJevBackend,
} from '../../src/shared/todoJevConfig'

class TodoJevConfigError extends Error {}

export function todoJevConfigErrorMessage(error: unknown): string {
  return error instanceof TodoJevConfigError ? error.message : '判断模型配置暂时无法读取或保存，请稍后重试。'
}

type StoredJevConfig = Omit<TodoJevConfigState, 'hasApiKey'> & { encryptedApiKey: string }

function normalizeEndpoint(value: unknown): string {
  try { return normalizeTodoJevEndpoint(value) } catch {
    throw new TodoJevConfigError('请输入完整的 HTTPS 判断接口地址，不含账号、查询参数或片段；本机服务可使用 localhost HTTP。')
  }
}

function requireSecureStorage(): void {
  let available = false
  try {
    available = safeStorage.isEncryptionAvailable() && !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text')
  } catch { /* No plaintext fallback when the OS keychain is unavailable. */ }
  if (!available) throw new TodoJevConfigError('系统安全存储不可用，不会以明文保存判断模型 API Key。')
}

function publicState(stored: StoredJevConfig): TodoJevConfigState {
  return { enabled: stored.enabled, backend: stored.backend, endpoint: stored.endpoint, model: stored.model, hasApiKey: Boolean(stored.encryptedApiKey) }
}

function readStored(): StoredJevConfig {
  const config = new ConfigService()
  try {
    const value = config.get('todoJevConfig')
    // Already saved configurations predate backend selection and belong to Jev.
    // New installations use the explicit Laya default in ConfigService.
    const backend: TodoJevBackend = value?.backend === 'laya' || !value ? 'laya' : 'jev'
    return {
      enabled: value?.enabled === true,
      backend,
      endpoint: value?.endpoint || (backend === 'laya' ? DEFAULT_LAYA_ENDPOINT : DEFAULT_JEV_ENDPOINT),
      model: value?.model || (backend === 'laya' ? DEFAULT_LAYA_MODEL : DEFAULT_JEV_MODEL),
      encryptedApiKey: value?.encryptedApiKey || '',
    }
  } finally { config.close() }
}

function decryptKey(value: string): string {
  if (!value) throw new TodoJevConfigError('远程判断服务或 Jev 需要独立的 API Key；本机 Laya 无需密钥。')
  requireSecureStorage()
  try {
    const key = safeStorage.decryptString(Buffer.from(value, 'base64')).trim()
    if (!key) throw new TodoJevConfigError()
    return key
  } catch { throw new TodoJevConfigError('无法读取已保存的判断服务 API Key，请重新填写后保存。') }
}

function validateModel(model: unknown, backend: TodoJevBackend): string {
  const value = typeof model === 'string' ? model.trim() : ''
  if (!value || value.length > 200 || /[\r\n\x00-\x1f]/.test(value)) throw new TodoJevConfigError('请填写有效的判断模型名称。')
  if (backend === 'laya' && value !== DEFAULT_LAYA_MODEL) throw new TodoJevConfigError('Laya 分析中文消息必须使用 multilingual 模型；laya 别名会选择英语模型。')
  return value
}

function prepareInput(input: TodoJevConfigInput, stored: StoredJevConfig) {
  if (!input || typeof input !== 'object' || typeof input.enabled !== 'boolean') throw new TodoJevConfigError('判断模型配置格式无效。')
  const backend = input.backend ?? stored.backend
  if (backend !== 'laya' && backend !== 'jev') throw new TodoJevConfigError('请选择 Laya 或 Jev 判断模式。')
  const endpoint = normalizeEndpoint(input.endpoint)
  const model = validateModel(input.model, backend)
  if (input.apiKey !== undefined && typeof input.apiKey !== 'string') throw new TodoJevConfigError('判断模型 API Key 格式无效。')
  const suppliedKey = input.apiKey?.trim() || ''
  if (suppliedKey.length > 8_192 || /[\r\n\x00-\x1f]/.test(suppliedKey)) throw new TodoJevConfigError('判断模型 API Key 格式无效。')
  if (input.clearApiKey && suppliedKey) throw new TodoJevConfigError('清除已保存密钥时，请先清空新密钥输入框。')
  const changedDestination = backend !== stored.backend || endpoint !== normalizeEndpoint(stored.endpoint)
  if (changedDestination && stored.encryptedApiKey && !suppliedKey && !input.clearApiKey) {
    throw new TodoJevConfigError('判断模式或接口地址已改变，请填写新服务专用的 API Key，或清除已保存密钥；旧密钥不会发送到新地址。')
  }
  return { backend, endpoint, model, suppliedKey,
    requiresApiKey: todoDecisionRequiresApiKey(backend, endpoint),
    keepSavedKey: !input.clearApiKey && !changedDestination && Boolean(stored.encryptedApiKey),
  }
}

export class TodoJevConfigService {
  getState(): TodoJevConfigState { return publicState(readStored()) }

  getRuntimeConfig(): TodoJevRuntimeConfig | null {
    const stored = readStored()
    if (!stored.enabled) return null
    const endpoint = normalizeEndpoint(stored.endpoint)
    return {
      backend: stored.backend, endpoint, model: validateModel(stored.model, stored.backend),
      apiKey: stored.encryptedApiKey || todoDecisionRequiresApiKey(stored.backend, endpoint) ? decryptKey(stored.encryptedApiKey) : '',
    }
  }

  configure(input: TodoJevConfigInput): TodoJevConfigState {
    const stored = readStored()
    const prepared = prepareInput(input, stored)
    let encryptedApiKey = prepared.keepSavedKey ? stored.encryptedApiKey : ''
    if (prepared.suppliedKey) {
      requireSecureStorage()
      try { encryptedApiKey = safeStorage.encryptString(prepared.suppliedKey).toString('base64') }
      catch { throw new TodoJevConfigError('系统安全存储未能加密 API Key，请稍后重试。') }
    }
    if (input.enabled && prepared.requiresApiKey && !encryptedApiKey) throw new TodoJevConfigError('启用远程判断服务或 Jev 前，请先填写独立的 API Key。')
    if (input.enabled && encryptedApiKey && !prepared.suppliedKey) decryptKey(encryptedApiKey)
    const next: StoredJevConfig = { enabled: input.enabled, backend: prepared.backend, endpoint: prepared.endpoint, model: prepared.model, encryptedApiKey }
    const config = new ConfigService()
    try {
      config.set('todoJevConfig', next)
      // ConfigService.set logs storage errors instead of throwing; verify its write.
      if (JSON.stringify(config.get('todoJevConfig')) !== JSON.stringify(next)) throw new Error()
    } catch { throw new TodoJevConfigError('判断模型配置保存失败，请稍后重试。') }
    finally { config.close() }
    return publicState(next)
  }

  async test(input: TodoJevConfigInput): Promise<{ success: boolean; error?: string }> {
    let runtime: TodoJevRuntimeConfig
    try {
      const stored = readStored()
      const prepared = prepareInput(input, stored)
      const savedKey = prepared.keepSavedKey ? stored.encryptedApiKey : ''
      runtime = {
        backend: prepared.backend, endpoint: prepared.endpoint, model: prepared.model,
        apiKey: prepared.suppliedKey || (savedKey || prepared.requiresApiKey ? decryptKey(savedKey) : ''),
      }
    } catch (error) { return { success: false, error: todoJevConfigErrorMessage(error) } }
    try {
      await testTodoJevConnection(runtime)
      return { success: true }
    } catch {
      return { success: false, error: runtime.backend === 'laya'
        ? 'Laya 测试未通过。请先启动 multilingual 本地服务，核对地址；远程地址还需要对应 API Key。测试不会保存配置。'
        : 'Jev 测试未通过，请检查网络、完整接口地址、模型及该服务专用的 API Key。测试不会保存配置。' }
    }
  }
}

export const todoJevConfigService = new TodoJevConfigService()
