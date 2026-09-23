import assert from 'node:assert/strict'
import { applyTodoFeedback, assessTodoImportance, buildTodoIntelligenceContext, compareTodoImportance, learnTodoPreferences, normalizeTopics } from '../src/shared/todoIntelligence.ts'
import { createEmptyTodoSyncDocument, decryptTodoSyncEnvelope, encryptTodoSyncDocument, mergeTodoSyncDocuments, redactTodoForSync } from '../src/shared/todoSync.ts'
import type { TodoItem, TodoSettings } from '../src/types/todo.ts'

const now = Date.parse('2026-09-05T08:00:00Z')
const item: TodoItem = {
  id: 'a', title: '确认合同', details: '', dueAt: null, priority: 'medium', status: 'pending',
  sourceType: 'wechat', sourceLabel: '项目群', sourceRef: 'wechat:1', sourcePreview: 'private message',
  confidence: .9, createdAt: now, updatedAt: now,
  insight: { kind: 'action', score: 60, baseScore: 60, adjustment: 0, reason: '需要确认', topics: ['交付', '交付'] },
}
const settings: TodoSettings = { autoScanEnabled: true, scanHour: 20, reminderEnabled: true, remindBeforeMinutes: 30, wallpaperEnabled: false, connectors: [], personalContext: '负责产品交付' }
assert.deepEqual(normalizeTopics([' AI ', 'ai', null, 4, '', '交付']), ['ai', '交付'])
const positive = applyTodoFeedback(item, 'useful', now)
assert.equal(positive.status, 'pending')
assert.equal(learnTodoPreferences([positive], now).topics[0].useful, 1)
assert.equal(learnTodoPreferences([positive, { ...positive, id: 'b' }], now).useful, 1, '一个来源不可重复增加证据')
const negative = applyTodoFeedback(positive, 'not-useful', now + 1)
assert.equal(negative.status, 'dismissed')
assert.equal(learnTodoPreferences([negative], now).useful, 0, '改票须替换旧反馈')
assert.equal(learnTodoPreferences([negative], now).notUseful, 1)
const undone = applyTodoFeedback(negative, null, now + 2)
assert.equal(undone.status, 'pending')
assert.equal(learnTodoPreferences([undone], now).topics.length, 0)
const completed = { ...item, status: 'completed' as const }
assert.equal(applyTodoFeedback(applyTodoFeedback(completed, 'not-useful', now), null, now + 1).status, 'completed')
assert.equal(learnTodoPreferences([completed], now).useful, 0, '完成不应偷偷当作正反馈')
assert.equal(learnTodoPreferences([{ ...positive, sourceType: 'manual' }], now).useful, 0)
assert.throws(() => applyTodoFeedback(item, 'bad' as any), /无效/)
const assessed = assessTodoImportance({ importance: 60, topics: ['交付'] }, null, [positive], true, now)
assert.ok(assessed.score > 60 && assessed.score <= 65, '少量证据只能温和调整')
const down = assessTodoImportance({ importance: 60, topics: ['交付'] }, null, [negative], true, now)
assert.ok(down.score < 60 && down.score >= 55)
assert.equal(assessTodoImportance({ importance: 60, topics: ['交付'] }, null, [negative], false, now).score, 60)
assert.equal(assessTodoImportance({ importance: 60, topics: ['其他'] }, null, [negative], true, now).score, 60)
assert.equal(assessTodoImportance({ importance: 20, topics: ['交付'] }, new Date(now + 3600000).toISOString(), [negative], true, now).score, 75, '明确临近时限保底')
assert.equal(assessTodoImportance({ kind: 'information', importance: 20 }, new Date(now).toISOString(), [], true, now).score, 20)
assert.equal(assessTodoImportance({ importance: NaN, priority: 'high' }, null, []).score, 80)
assert.equal(assessTodoImportance({ importance: Infinity }, null, []).score, 55)
assert.equal(assessTodoImportance({ importance: -50 }, null, []).score, 0)
assert.equal(assessTodoImportance({ importance: 500 }, null, []).score, 100)
assert.ok(learnTodoPreferences([positive], now + 365 * 86400000).topics[0].adjustment < learnTodoPreferences([positive], now).topics[0].adjustment, '旧反馈衰减')
const context = JSON.parse(buildTodoIntelligenceContext(settings, [positive], now))
assert.equal(context.userProvidedContext, '负责产品交付')
assert.equal(context.feedbackTopics[0].topic, '交付')
assert.ok(!JSON.stringify(context).includes('private message'))
assert.deepEqual(JSON.parse(buildTodoIntelligenceContext({ ...settings, learningEnabled: false }, [positive], now)).feedbackTopics, [])
assert.ok(compareTodoImportance({ ...item, insight: assessed }, item) < 0)

// Mobile feedback survives encryption, source redaction, desktop merge, and withdrawal.
const desktop = { ...createEmptyTodoSyncDocument('desktop'), items: [item], updatedAt: now }
const phone = { ...desktop, deviceId: 'phone', revision: 2, updatedAt: now + 1, items: [redactTodoForSync(negative, false)] }
const envelope = await encryptTodoSyncDocument(phone, 'test-secret-with-enough-length')
const decoded = await decryptTodoSyncEnvelope(envelope, 'test-secret-with-enough-length')
const merged = mergeTodoSyncDocuments(desktop, decoded, 'desktop', now + 10)
assert.equal(merged.items[0].feedback, 'not-useful')
assert.equal(merged.items[0].sourcePreview, '')
assert.equal(learnTodoPreferences(merged.items, now).notUseful, 1)
const withdrawal = { ...phone, items: [undone], updatedAt: now + 2 }
assert.equal(mergeTodoSyncDocuments(merged, withdrawal, 'desktop', now + 11).items[0].feedback, null)
console.log('todo intelligence tests passed: preference updates, evidence limits, deadlines, privacy, encrypted mobile feedback')
