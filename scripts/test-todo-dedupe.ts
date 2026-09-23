import assert from 'node:assert/strict'
import { todoExtractionDedupeKey } from '../src/shared/todoDedupe.ts'

const first = todoExtractionDedupeKey('wechat:group:1', ' 回复项目组 ', '2026-09-01T10:00:00.000Z')
assert.equal(first, todoExtractionDedupeKey('wechat:group:1', '回复项目组', '2026-09-01T18:00:00.000Z'), '同一来源同标题同截止日应去重')
assert.notEqual(first, todoExtractionDedupeKey('gmail:message:2', '回复项目组', '2026-09-01T10:00:00.000Z'), '不同来源的真实任务不能被全局标题去重误删')
assert.notEqual(first, todoExtractionDedupeKey('wechat:group:1', '回复项目组', '2026-09-02T10:00:00.000Z'), '同一来源不同截止日应保留')

console.log('todo extraction dedupe tests passed')
