import assert from 'node:assert/strict'
import { shouldRunTodoAutoScan, todoScanSinceSeconds, todoScheduleDayKey } from '../src/shared/todoSchedule.ts'

const due = new Date(2026, 7, 31, 20, 0, 0, 0)
const settings = { autoScanEnabled: true, scanHour: 20 }

assert.equal(todoScheduleDayKey(due), '2026-08-31')
assert.equal(shouldRunTodoAutoScan(settings, { lastAutoScanDay: '', lastScanAt: 0, lastError: '' }, new Date(2026, 7, 31, 19, 59)), false, '首次运行到点前不能启动')
assert.equal(shouldRunTodoAutoScan(settings, { lastAutoScanDay: '', lastScanAt: 0, lastError: '' }, due), true, '首次运行到点后应启动')
assert.equal(shouldRunTodoAutoScan({ ...settings, autoScanEnabled: false }, { lastAutoScanDay: '', lastScanAt: 0, lastError: '' }, due), false, '关闭自动扫描后不能运行')
assert.equal(shouldRunTodoAutoScan(settings, { lastAutoScanDay: '2026-08-31', lastScanAt: due.getTime() - 59 * 60_000, lastError: '' }, due), false, '成功后每小时内不能重复运行')
assert.equal(shouldRunTodoAutoScan(settings, { lastAutoScanDay: '2026-08-31', lastScanAt: due.getTime() - 60 * 60_000, lastError: '' }, due), true, '成功满一小时必须继续增量扫描')
assert.equal(shouldRunTodoAutoScan(settings, { lastAutoScanDay: '', lastScanAt: due.getTime() - 14 * 60_000, lastError: '读取失败' }, due), false, '失败后保护间隔内不能立即重试')
assert.equal(shouldRunTodoAutoScan(settings, { lastAutoScanDay: '', lastScanAt: due.getTime() - 15 * 60_000, lastError: '读取失败' }, due), true, '失败后达到保护间隔必须重试')
assert.equal(shouldRunTodoAutoScan(settings, { lastAutoScanDay: '2026-08-31', lastScanAt: due.getTime() - 60 * 60_000, lastError: '' }, new Date(2026, 8, 1, 0, 0)), true, '已经启动的增量扫描必须跨午夜继续')
assert.equal(shouldRunTodoAutoScan({ ...settings, scanHour: 99 }, { lastAutoScanDay: '', lastScanAt: 0, lastError: '' }, new Date(2026, 7, 31, 22, 0)), false, '异常小时必须限制到 23 点')

const midnight = new Date(2026, 8, 1, 0, 5, 0, 0)
const previousLateScan = new Date(2026, 7, 31, 23, 0, 0, 0).getTime()
assert.equal(todoScanSinceSeconds(0, midnight), Math.floor(new Date(2026, 8, 1, 0, 0, 0, 0).getTime() / 1000), '首次扫描只读取当天')
assert.equal(todoScanSinceSeconds(previousLateScan, midnight), Math.floor(previousLateScan / 1000) - 60, '跨午夜要从上一轮成功点回退一分钟补扫')
assert.equal(todoScanSinceSeconds(new Date(2026, 7, 20).getTime(), midnight), Math.floor((midnight.getTime() - 24 * 60 * 60 * 1000) / 1000), '久未运行时补扫窗口最多 24 小时')

console.log('todo auto-scan schedule tests passed')
