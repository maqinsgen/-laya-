export const AWS_BEDROCK_MANTLE_PROVIDER_ID = 'aws-bedrock-mantle'

export const AWS_BEDROCK_MANTLE_DIRECT_BASE_URL = 'https://bedrock-mantle.us-west-2.api.aws/v1'
export const AWS_BEDROCK_MANTLE_LOCAL_PROXY_URL = 'http://127.0.0.1:15721/v1'
export const AWS_BEDROCK_MANTLE_DEFAULT_MODEL = 'google.gemma-3-12b-it'

export const AWS_BEDROCK_MANTLE_MODELS = [
  'google.gemma-3-12b-it',
  'google.gemma-3-27b-it',
  'google.gemma-3-4b-it',
  'xai.grok-4.6',
  'anthropic.claude-haiku-4-5',
  'deepseek.v3.2',
]

export function normalizeAwsBedrockBaseURL(value: string): string {
  return String(value || '').trim().replace(/\/+$/, '')
}

/** Gemma 等模型走 /v1/chat/completions，不是 /openai/v1。 */
export function toAwsBedrockChatBaseURL(value: string): string {
  const normalized = normalizeAwsBedrockBaseURL(value)
  if (!normalized) return AWS_BEDROCK_MANTLE_DIRECT_BASE_URL
  if (normalized.endsWith('/openai/v1')) return `${normalized.slice(0, -'/openai/v1'.length)}/v1`
  if (normalized.endsWith('/openai')) return `${normalized.slice(0, -'/openai'.length)}/v1`
  return normalized
}

export function isAwsBedrockLocalProxyUrl(value: string): boolean {
  try {
    const url = new URL(normalizeAwsBedrockBaseURL(value))
    return (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.port === '15721'
  } catch {
    return false
  }
}

/** 从 CC-Switch 的 provider.settings_config JSON 里取出 Bedrock API Key，不改写原文。 */
export function extractCcSwitchAwsApiKey(settingsConfig: unknown): string {
  if (!settingsConfig) return ''
  const parsed = typeof settingsConfig === 'string'
    ? JSON.parse(settingsConfig) as Record<string, unknown>
    : settingsConfig as Record<string, unknown>
  const auth = parsed.auth && typeof parsed.auth === 'object'
    ? parsed.auth as Record<string, unknown>
    : {}
  const fromAuth = String(auth.OPENAI_API_KEY || auth.api_key || '').trim()
  if (fromAuth) return fromAuth
  const configText = String(parsed.config || '')
  const match = configText.match(/api_key\s*=\s*"([^"]+)"/i)
  return match?.[1]?.trim() || ''
}

export function extractCcSwitchAwsBaseURL(settingsConfig: unknown): string {
  if (!settingsConfig) return ''
  const parsed = typeof settingsConfig === 'string'
    ? JSON.parse(settingsConfig) as Record<string, unknown>
    : settingsConfig as Record<string, unknown>
  const configText = String(parsed.config || '')
  const match = configText.match(/base_url\s*=\s*"([^"]+)"/i)
  return normalizeAwsBedrockBaseURL(match?.[1] || '')
}

export function selectAwsProxyFromCcSwitchRows(
  rows: Array<{ id?: string; name?: string; settings_config?: unknown }>,
): { apiKey: string; baseURL: string; model: string; source: string } | null {
  for (const row of rows) {
    const apiKey = extractCcSwitchAwsApiKey(row.settings_config)
    if (!apiKey) continue
    const extractedBase = extractCcSwitchAwsBaseURL(row.settings_config)
    return {
      apiKey,
      baseURL: extractedBase.toLowerCase().includes('bedrock-mantle')
        ? toAwsBedrockChatBaseURL(extractedBase)
        : AWS_BEDROCK_MANTLE_DIRECT_BASE_URL,
      model: AWS_BEDROCK_MANTLE_DEFAULT_MODEL,
      source: row.name || row.id || 'cc-switch',
    }
  }
  return null
}
