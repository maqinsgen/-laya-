/** Timing and progress for the read-only macOS key acquisition path. */
export const WECHAT_AUTHORIZATION_TIMEOUT_MS = 90_000

export type WechatMemoryProgress = {
  stage: 'authorized' | 'attaching' | 'scanning' | 'done' | 'timeout' | 'cancelled' | 'error'
  regions: number
  scannedBytes: number
  candidates: number
  elapsedMs: number
  errorCode?: 'ATTACH_DENIED' | 'REGION_ENUMERATION_FAILED' | 'SCAN_COMPONENT_FAILED'
}

/** Only permit counters and known stages across the privileged helper boundary. */
export function parseWechatMemoryProgress(raw: unknown): WechatMemoryProgress | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (!['authorized', 'attaching', 'scanning', 'done', 'timeout', 'cancelled', 'error'].includes(String(value.stage))) return null
  const names = ['regions', 'scannedBytes', 'candidates', 'elapsedMs'] as const
  if (names.some(name => typeof value[name] !== 'number' || !Number.isSafeInteger(value[name]) || (value[name] as number) < 0)) return null
  return {
    stage: value.stage as WechatMemoryProgress['stage'],
    regions: value.regions as number, scannedBytes: value.scannedBytes as number,
    candidates: value.candidates as number, elapsedMs: value.elapsedMs as number,
    ...(['ATTACH_DENIED', 'REGION_ENUMERATION_FAILED', 'SCAN_COMPONENT_FAILED'].includes(String(value.errorCode))
      ? { errorCode: value.errorCode as WechatMemoryProgress['errorCode'] } : {}),
  }
}

export function formatWechatMemoryProgress(progress: WechatMemoryProgress): string {
  if (progress.stage === 'authorized' || progress.stage === 'attaching') return '管理员授权已完成，正在检查微信进程读取权限…'
  if (progress.errorCode === 'ATTACH_DENIED') return '已完成管理员授权，但系统仍阻止读取微信进程。'
  if (progress.stage === 'error') return '本机读取组件中断，未完成本次扫描。'
  const counters = `${progress.regions} 个内存区 · ${Math.round(progress.scannedBytes / 1_048_576)} MB · ${progress.candidates} 个候选`
  if (progress.stage === 'timeout') return `扫描时间已到，正在验证已发现的候选：${counters}`
  if (progress.stage === 'done') return `内存扫描完成：${counters}`
  if (progress.stage === 'cancelled') return '已取消内存扫描。'
  return `正在只读扫描：${counters}`
}

export function isWechatAuthorizationCancelled(value: string): boolean {
  return /WF_ERR::-128(?:::|$)|\(-128\)|User cancel(?:ed|led)/i.test(value)
}
