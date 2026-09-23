/**
 * 在主进程解析当前 AI provider 配置，注入给 AI 子进程（子进程不依赖 ConfigService/catalog）。
 * 复用现有 ConfigService + catalog，不新增配置来源。
 */
import { ConfigService } from '../config'
import { getProviderDefinition, normalizeProviderId } from '../ai/providers/catalog'
import { getResolvedProxyUrl } from '../ai/proxyFetch'
import { evaluateAIProviderReadiness } from '../../../src/shared/aiProviderReadiness'
import type { AgentProviderConfig, AgentProviderConfigOverride } from './types'

export function resolveProviderConfig(override?: AgentProviderConfigOverride | null): AgentProviderConfig {
  const config = new ConfigService()
  try {
    const name = normalizeProviderId(override?.provider || config.getAICurrentProvider() || 'deepseek')
    const def = getProviderDefinition(name)
    if (!def) throw new Error(`不支持的 AI 服务商: ${name}`)

    const providerConfig = {
      ...(config.getAIProviderConfig(name) || {}),
      ...(override || {}),
    }
    const readiness = evaluateAIProviderReadiness(name, providerConfig, def)
    if (!readiness.ready) throw new Error(readiness.error)
    const { model, baseURL } = readiness
    // AI SDK 的 provider 类型要求非空 key；无需密钥的本地兼容服务使用 provider id 占位。
    const apiKey = readiness.apiKey || name

    // 模型上下文窗口（token），供引擎 >90% 自动压缩判断用；自定义/未知模型取不到则留空，引擎兜默认值
    const contextWindow = def.modelDetails?.find((item) => item.id === model)?.limits?.context

    return {
      providerKind: providerConfig?.protocol || def.protocol || 'openai-compatible',
      name,
      apiKey,
      baseURL,
      model,
      reasoningEffort: providerConfig?.reasoningEffort,
      proxyUrl: getResolvedProxyUrl() || undefined,
      contextWindow: typeof contextWindow === 'number' && contextWindow > 0 ? contextWindow : undefined,
      anthropicCacheTtl: config.get('anthropicCacheTtl') === '1h' ? '1h' : '5m',
    }
  } finally {
    config.close()
  }
}
