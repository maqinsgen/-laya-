export const DEFAULT_JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
export const DEFAULT_JEV_MODEL = 'jev-latest'
export const DEFAULT_LAYA_ENDPOINT = 'http://127.0.0.1:8000/v1/systemone'
/** The official server's `laya` alias selects English, so always name multilingual explicitly. */
export const DEFAULT_LAYA_MODEL = 'multilingual'
export type TodoJevBackend = 'laya' | 'jev'

export interface TodoJevConfigState {
  enabled: boolean
  backend: TodoJevBackend
  endpoint: string
  model: string
  hasApiKey: boolean
}

export interface TodoJevConfigInput {
  enabled: boolean
  /** Absent only for older IPC callers; keep their previously saved backend. */
  backend?: TodoJevBackend
  endpoint: string
  model: string
  /** Empty / absent keeps the saved key only for the same backend and endpoint. */
  apiKey?: string
  clearApiKey?: boolean
}

export interface TodoJevRuntimeConfig {
  backend: TodoJevBackend
  endpoint: string
  model: string
  apiKey: string
}

export function isLocalTodoDecisionEndpoint(value: string): boolean {
  try {
    const url = new URL(value)
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}

export function todoDecisionRequiresApiKey(backend: TodoJevBackend, endpoint: string): boolean {
  return backend !== 'laya' || !isLocalTodoDecisionEndpoint(endpoint)
}

/** Explicit endpoints only; never send a saved credential through a redirect. */
export function normalizeTodoJevEndpoint(value: unknown): string {
  const url = new URL(String(value || DEFAULT_JEV_ENDPOINT).trim())
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('判断接口需要 HTTPS；本机服务可使用 localhost HTTP。')
  if (url.username || url.password || url.search || url.hash) throw new Error('判断接口地址不能包含账号、查询参数或片段。')
  return url.toString().replace(/\/$/, '')
}
