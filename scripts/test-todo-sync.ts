import assert from 'node:assert/strict'
import {
  createEmptyTodoSyncDocument,
  decryptTodoSyncEnvelope,
  encryptTodoSyncDocument,
  generateTodoSyncSecret,
  mergeTodoSyncDocuments,
  redactTodoForSync,
} from '../src/shared/todoSync.ts'
import type { TodoItem, TodoSyncDocument } from '../src/types/todo.ts'

function item(id: string, updatedAt: number, title = id): TodoItem {
  return {
    id,
    title,
    details: '逐字摘抄的消息详情',
    dueAt: null,
    priority: 'medium',
    status: 'pending',
    sourceType: 'wechat',
    sourceLabel: '项目群',
    sourceRef: `message:${id}`,
    sourcePreview: '这段原始消息默认不应同步',
    confidence: 0.9,
    evidence: { engine: 'jev', messageQuote: '仅用于本机核对的原文', dateQuote: '明天下午三点', date: '2026-09-24', dateStatus: 'date-only', needsReview: true, decisionConfidence: 0.9 },
    createdAt: updatedAt,
    updatedAt,
  }
}

function document(deviceId: string, items: TodoItem[], updatedAt: number): TodoSyncDocument {
  return {
    ...createEmptyTodoSyncDocument(deviceId),
    revision: 1,
    updatedAt,
    items,
  }
}

async function main(): Promise<void> {
  const secret = generateTodoSyncSecret()
  assert.ok(secret.length >= 40, 'generated recovery secret should retain at least 256 bits')

  const event = { ...item('one', 100), dueAt: '2026-09-30T01:00:00.000Z', endAt: '2026-09-30T02:30:00.000Z', sourceCreatedAt: 1790128800 }
  const original = document('mac-a', [event], 100)
  const envelope = await encryptTodoSyncDocument(original, secret, {
    salt: new Uint8Array(16).fill(7),
    iterations: 100_000,
  })
  const decrypted = await decryptTodoSyncEnvelope(envelope, secret)
  assert.deepEqual(decrypted, original, 'encrypted sync files must make a lossless round trip')
  assert.equal(redactTodoForSync(event, false).endAt, event.endAt, 'event duration survives source redaction for mobile calendars')
  await assert.rejects(
    () => decryptTodoSyncEnvelope(envelope, 'this-is-the-wrong-secret'),
    /同步密码错误/,
    'a wrong recovery secret must never produce partial plaintext',
  )

  const local = document('mac-a', [item('same', 200, '本地旧标题'), item('local-only', 180)], 200)
  const remote = document('phone-b', [item('same', 240, '手机端新标题'), item('remote-only', 220)], 240)
  const merged = mergeTodoSyncDocuments(local, remote, 'mac-a', 300)
  assert.equal(merged.items.find((candidate) => candidate.id === 'same')?.title, '手机端新标题')
  assert.deepEqual(new Set(merged.items.map((candidate) => candidate.id)), new Set(['same', 'local-only', 'remote-only']))
  assert.equal(merged.deviceId, 'mac-a')

  const deletedRemote: TodoSyncDocument = {
    ...document('phone-b', [], 300),
    tombstones: [{ id: 'local-only', deletedAt: 250, deviceId: 'phone-b' }],
  }
  const afterDelete = mergeTodoSyncDocuments(local, deletedRemote, 'mac-a', 320)
  assert.equal(afterDelete.items.some((candidate) => candidate.id === 'local-only'), false, 'newer tombstones must defeat stale items')
  assert.equal(afterDelete.tombstones.some((candidate) => candidate.id === 'local-only'), true)

  const resurrectedLocal = document('mac-a', [item('local-only', 280, '确认恢复')], 280)
  const afterRestore = mergeTodoSyncDocuments(resurrectedLocal, deletedRemote, 'mac-a', 340)
  assert.equal(afterRestore.items.find((candidate) => candidate.id === 'local-only')?.title, '确认恢复')
  assert.equal(afterRestore.tombstones.some((candidate) => candidate.id === 'local-only'), false, 'an explicitly newer edit may restore a deleted item')

  assert.equal(redactTodoForSync(item('private', 400), false).sourcePreview, '', 'source previews are private by default')
  assert.notEqual(redactTodoForSync(item('shared', 400), true).sourcePreview, '', 'users may explicitly include source previews')
  const redacted = redactTodoForSync(item('private', 400), false)
  assert.equal(redacted.evidence?.messageQuote, '', 'new evidence must obey the existing source preview privacy switch')
  assert.equal(redacted.evidence?.dateQuote, undefined)
  assert.equal(redacted.details, '', 'Jev details repeat the source and must also be redacted')
  assert.equal(redacted.title, 'private', 'the short task title remains part of the synced result')
  const localModel = item('local-model', 400)
  localModel.evidence!.engine = 'laya'
  assert.equal(redactTodoForSync(localModel, false).details, '', 'local model verbatim details follow the same privacy setting')
  assert.equal(redacted.evidence?.date, '2026-09-24', 'derived date and review status remain available on phones')
  assert.equal(redacted.evidence?.needsReview, true)
  assert.equal(redactTodoForSync(item('shared', 400), true).evidence?.messageQuote, '仅用于本机核对的原文')

  console.log('todo sync encryption and merge tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
