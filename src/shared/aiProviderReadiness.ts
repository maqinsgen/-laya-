export type AIProviderConfigForReadiness = {
  apiKey?: string
  model?: string
  baseURL?: string
}

export type AIProviderDefinitionForReadiness = {
  models?: string[]
  baseURL?: string
  optionalApiKey?: boolean
  allowCustomBaseURL?: boolean
}

export type AIProviderReadiness =
  | {
      ready: true
      apiKey: string
      model: string
      baseURL: string
    }
  | {
      ready: false
      error: string
    }

/**
 * 对齐“界面显示已配置”和“真正发起请求”所需的最小条件。
 * 不接触密钥存储，只检查调用方已经读取到的配置。
 */
export function evaluateAIProviderReadiness(
  providerId: string,
  config: AIProviderConfigForReadiness | null | undefined,
  definition: AIProviderDefinitionForReadiness | null | undefined,
): AIProviderReadiness {
  if (!definition) {
    return { ready: false, error: `不支持的 AI 服务商: ${providerId}` }
  }

  const apiKey = String(config?.apiKey || '').trim()
  const model = String(config?.model || definition.models?.[0] || '').trim()
  const baseURL = String(config?.baseURL || definition.baseURL || '').trim()

  if (!apiKey && !definition.optionalApiKey) {
    return { ready: false, error: '未配置 AI 服务商的 API Key，请先在设置中配置' }
  }
  if (!model) {
    return { ready: false, error: '未选择模型，请先在设置中选择模型' }
  }
  if (definition.allowCustomBaseURL && !baseURL) {
    return { ready: false, error: '自定义 AI 服务需要配置服务地址' }
  }

  return { ready: true, apiKey, model, baseURL }
}
