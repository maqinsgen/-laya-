import type { TodoScanState, TodoSettings } from '../types/todo'

export const TODO_AUTO_SCAN_RETRY_GUARD_MS = 15 * 60 * 1000
export const TODO_AUTO_SCAN_INTERVAL_MS = 60 * 60 * 1000
export const TODO_SCAN_CATCHUP_MS = 24 * 60 * 60 * 1000

export function todoScheduleDayKey(now = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function shouldRunTodoAutoScan(
  settings: Pick<TodoSettings, 'autoScanEnabled' | 'scanHour'>,
  scan: Pick<TodoScanState, 'lastAutoScanDay' | 'lastScanAt' | 'lastError'>,
  now = new Date(),
  retryGuardMs = TODO_AUTO_SCAN_RETRY_GUARD_MS,
  successIntervalMs = TODO_AUTO_SCAN_INTERVAL_MS,
): boolean {
  if (!settings.autoScanEnabled) return false
  const scanHour = Math.max(0, Math.min(23, Math.floor(Number(settings.scanHour) || 0)))
  // 首次自动运行尊重用户选择的时刻；一旦启动过，就持续做每小时增量，
  // 包括跨午夜补上上一轮之后到达的消息。
  if (!scan.lastAutoScanDay && now.getHours() < scanHour) return false

  const lastAttemptAt = Math.max(0, Number(scan.lastScanAt) || 0)
  if (lastAttemptAt === 0) return true
  const waitMs = scan.lastError
    ? Math.max(0, retryGuardMs)
    : Math.max(0, successIntervalMs)
  return now.getTime() - lastAttemptAt >= waitMs
}

export function todoScanSinceSeconds(lastSuccessfulScanAt: number, now = new Date()): number {
  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  const todayStartSeconds = Math.floor(todayStart.getTime() / 1000)
  const lastSuccessfulSeconds = Math.floor(Math.max(0, Number(lastSuccessfulScanAt) || 0) / 1000)
  if (!lastSuccessfulSeconds) return todayStartSeconds
  const catchupFloor = Math.floor((now.getTime() - TODO_SCAN_CATCHUP_MS) / 1000)
  return Math.max(catchupFloor, lastSuccessfulSeconds - 60)
}
