import type { TodoJevRuntimeConfig } from '../../src/shared/todoJevConfig'
import { DEFAULT_LAYA_MODEL, normalizeTodoJevEndpoint, todoDecisionRequiresApiKey } from '../../src/shared/todoJevConfig'
import { TODO_LAYA_STATE_MAX_BYTES, readJevChoice, type JevQuestion } from '../../src/shared/todoDecision'

export type TodoJevResponse = { answers: Record<string, unknown>; usage?: { input_tokens?: number; output_tokens?: number } }
class SafeJevResponseError extends Error {}

/** Protocol reference: jev-chat/jev-chat-jarvis JudgeClient (MIT), see THIRD_PARTY_NOTICES/Jev. */
export async function requestTodoJev(config: TodoJevRuntimeConfig, state: unknown, questions: Record<string, JevQuestion>): Promise<TodoJevResponse> {
  const endpoint = normalizeTodoJevEndpoint(config.endpoint)
  const backend = config.backend || 'jev'
  const label = backend === 'laya' ? 'Laya' : 'Jev'
  if (!config.model?.trim() || (todoDecisionRequiresApiKey(backend, endpoint) && !config.apiKey?.trim())) throw new Error('请先配置判断模型；远程接口与 Jev 需要专用 API Key。')
  if (backend === 'laya' && config.model !== DEFAULT_LAYA_MODEL) throw new Error('Laya 中文判断需要 multilingual 模型。')
  if (backend === 'laya') {
    const entries = Object.values(questions)
    const head = entries.map(question => [question.instructions, ...Object.values(question.criteria)].join('\n')).join('\n')
    if (typeof state !== 'string' || Buffer.byteLength(state, 'utf8') > TODO_LAYA_STATE_MAX_BYTES || entries.length !== 1
      || Object.keys(entries[0].criteria).length > 4 || Buffer.byteLength(head, 'utf8') > 224) {
      throw new Error('Laya 输入超过本地短文本预算，请保留原文供人工核对。')
    }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(config.apiKey?.trim() ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
      body: JSON.stringify({ model: config.model, state, questions }),
    })
    if (!response.ok) throw new SafeJevResponseError(`${label} 请求失败（HTTP ${response.status}），请检查接口配置或稍后重试。`)
    if (!response.body) throw new SafeJevResponseError(`${label} 返回了空响应。`)
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > 1_048_576) { await reader.cancel(); throw new SafeJevResponseError(`${label} 响应过大，已停止处理。`) }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!data || typeof data.answers !== 'object' || !data.answers || Array.isArray(data.answers)) throw new SafeJevResponseError(`${label} 响应缺少 answers，请使用 decisions/systemone 接口。`)
    for (const [id, question] of Object.entries(questions)) readJevChoice(data.answers[id], Object.keys(question.criteria))
    return { answers: data.answers, usage: data.usage }
  } catch (error) {
    // Never echo a provider response, URL query, bearer token, or message text into logs/UI.
    if (error instanceof SafeJevResponseError) throw error
    throw new Error(controller.signal.aborted ? `${label} 请求超时，未完成的消息可重试。` : `${label} 连接或响应解析失败，请检查接口与模型配置。`)
  } finally { clearTimeout(timer) }
}

export async function testTodoJevConnection(config: TodoJevRuntimeConfig): Promise<void> {
  if (config.backend === 'laya') {
    const response = await requestTodoJev(config, '这张卡片是蓝色的。', {
      color: { type: 'choice', instructions: '卡片是什么颜色？', criteria: { blue: '蓝色', red: '红色', unknown: '没有说明' } },
    })
    if (readJevChoice(response.answers.color, ['blue', 'red', 'unknown']).choice !== 'blue') throw new Error('Laya 连通测试未通过，请确认服务加载了 multilingual 模型。')
    return
  }
  const response = await requestTodoJev(config, { message: 'This is a synthetic connectivity test. The color is blue.' }, {
    color: { type: 'choice', instructions: 'Read state.message and select the explicitly stated color.', criteria: { blue: 'Blue is stated.', red: 'Red is stated.', unknown: 'No color is stated.' } },
  })
  if (readJevChoice(response.answers.color, ['blue', 'red', 'unknown']).choice !== 'blue') throw new Error('Jev 连通测试未收到有效的选择题结果，请核对模型。')
}
