import assert from 'node:assert/strict'
import { normalizeTodoImapPort } from '../src/shared/todoMailConfig.ts'

assert.equal(normalizeTodoImapPort(undefined, true), 993, 'SSL/TLS 默认使用 993')
assert.equal(normalizeTodoImapPort(undefined, false), 143, 'STARTTLS 默认使用 143')
assert.equal(normalizeTodoImapPort(1993, true), 1993, '自定义端口必须保留')
assert.equal(normalizeTodoImapPort(0, false), 143, '空端口应回退到安全默认值')
assert.equal(normalizeTodoImapPort(99_999, true), 65_535, '端口必须限制在 TCP 合法范围')

console.log('todo IMAP connection config tests passed')
