import assert from 'node:assert/strict'
import { evaluateAIProviderReadiness } from '../src/shared/aiProviderReadiness.ts'

const standard = {
  models: ['text-model'],
  baseURL: 'https://api.example.com/v1',
}

assert.equal(evaluateAIProviderReadiness('cloud', { apiKey: 'secret' }, standard).ready, true, '云端服务可使用默认模型')
assert.equal(evaluateAIProviderReadiness('cloud', {}, standard).ready, false, '云端服务缺少密钥时不能显示为已配置')
assert.equal(evaluateAIProviderReadiness('cloud', { apiKey: 'secret', model: 'chosen-model' }, standard).ready, true, '显式模型可覆盖默认模型')

const custom = { models: [], baseURL: '', allowCustomBaseURL: true }
assert.equal(evaluateAIProviderReadiness('custom', { apiKey: 'secret', model: 'model' }, custom).ready, false, '自定义服务缺少地址时不能显示为已配置')
assert.equal(evaluateAIProviderReadiness('custom', { apiKey: 'secret', baseURL: 'https://gateway.example/v1' }, custom).ready, false, '自定义服务缺少模型时不能显示为已配置')
assert.equal(evaluateAIProviderReadiness('custom', { apiKey: 'secret', model: 'model', baseURL: 'https://gateway.example/v1' }, custom).ready, true, '完整自定义服务应可用')

const local = { models: ['local-model'], baseURL: 'http://127.0.0.1:11434/v1', optionalApiKey: true }
const localReadiness = evaluateAIProviderReadiness('local', {}, local)
assert.equal(localReadiness.ready, true, '明确声明密钥可选的本地服务无需密钥')
if (localReadiness.ready) assert.equal(localReadiness.apiKey, '', '纯检查不得伪造或保存密钥')

assert.equal(evaluateAIProviderReadiness('missing', { apiKey: 'secret' }, undefined).ready, false, '未知服务商不能显示为已配置')

console.log('AI provider readiness tests passed')
