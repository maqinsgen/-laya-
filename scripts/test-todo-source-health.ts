import assert from 'node:assert/strict'
import { buildTodoSourceFailure, finalizeTodoScanState, isTodoConnectorEnabled, todoSourceScanOutcome } from '../src/shared/todoSourceHealth.ts'

assert.equal(buildTodoSourceFailure([]), '')
assert.equal(
  buildTodoSourceFailure([' Gmail 读取失败\n', 'Gmail  读取失败']),
  '信息来源读取不完整：Gmail 读取失败',
  '相同来源错误必须归一化去重',
)
const many = buildTodoSourceFailure(['一', '二', '三', '四', '五', '六', '七'])
assert.match(many, /一；二；三；四；五；另有 2 个来源失败/)

assert.equal(isTodoConnectorEnabled(undefined, 'wechat'), true, '旧配置缺少 connector 时默认保持微信扫描')
assert.equal(isTodoConnectorEnabled([{ id: 'wx', type: 'wechat', name: '微信', enabled: false, status: 'connected' }], 'wechat'), false)
assert.equal(isTodoConnectorEnabled([{ id: 'mail', type: 'imap', name: '邮箱', enabled: true, status: 'connected' }], 'wechat'), true)
assert.equal(todoSourceScanOutcome('', 0), 'complete')
assert.equal(todoSourceScanOutcome('微信读取失败', 0), 'failed')
assert.equal(todoSourceScanOutcome('微信读取失败', 3), 'partial', '成功来源应先处理，失败来源稍后重试')

const baseScan = {
  lastScanAt: 200,
  lastSuccessfulScanAt: 100,
  lastAutoScanDay: '',
  processedFingerprints: ['old', 'same'],
  analyzedMessages: 4,
  extractedTodos: 1,
  lastError: '',
}
const partial = finalizeTodoScanState(baseScan, {
  outcome: 'partial',
  completedAt: 300,
  completedFingerprints: ['same', 'mail-new'],
  analyzedMessages: 2,
  extractedTodos: 1,
  sourceFailure: '微信读取失败',
})
assert.equal(partial.lastSuccessfulScanAt, 100, '部分成功不得推进全局游标，失败来源仍需补扫')
assert.deepEqual(partial.processedFingerprints, ['old', 'same', 'mail-new'], '成功来源指纹必须去重保存')
assert.equal(partial.lastError, '微信读取失败')
const complete = finalizeTodoScanState(baseScan, {
  outcome: 'complete',
  completedAt: 300,
  completedFingerprints: ['mail-new'],
  analyzedMessages: 2,
  extractedTodos: 1,
  sourceFailure: '',
})
assert.equal(complete.lastSuccessfulScanAt, 300, '全来源成功后才推进扫描游标')

console.log('todo source health tests passed')
