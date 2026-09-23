import type { TodoItem } from '../types/todo'

export interface DailyTodoWallpaperTheme {
  dayKey: string
  palette: [string, string, string]
  sunX: number
  sunY: number
  backPeaks: number[]
  frontPeaks: number[]
}

const PALETTES: Array<[string, string, string]> = [
  ['#0f172a', '#1d4ed8', '#67e8f9'],
  ['#1e1b4b', '#7c3aed', '#f0abfc'],
  ['#052e16', '#047857', '#a7f3d0'],
  ['#431407', '#ea580c', '#fde68a'],
  ['#172554', '#0369a1', '#bae6fd'],
  ['#3f0d2c', '#be185d', '#fbcfe8'],
  ['#1c1917', '#78716c', '#fed7aa'],
  ['#022c22', '#0f766e', '#99f6e4'],
]

export function todoWallpaperDayKey(date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function todoWallpaperDateLabel(date = new Date()): string {
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

function seedFromDayKey(dayKey: string): number {
  let seed = 2166136261
  for (let index = 0; index < dayKey.length; index += 1) {
    seed ^= dayKey.charCodeAt(index)
    seed = Math.imul(seed, 16777619)
  }
  return seed >>> 0
}

function nextRandom(state: { value: number }): number {
  state.value = (Math.imul(state.value, 1664525) + 1013904223) >>> 0
  return state.value / 0x1_0000_0000
}

export function dailyTodoWallpaperTheme(date = new Date()): DailyTodoWallpaperTheme {
  const dayKey = todoWallpaperDayKey(date)
  const state = { value: seedFromDayKey(dayKey) }
  const palette = PALETTES[Math.floor(nextRandom(state) * PALETTES.length)]
  const peaks = (minimum: number, spread: number): number[] => [
    0,
    ...Array.from({ length: 5 }, () => Math.round(minimum + nextRandom(state) * spread)),
    0,
  ]
  return {
    dayKey,
    palette,
    sunX: Math.round(260 + nextRandom(state) * 920),
    sunY: Math.round(340 + nextRandom(state) * 520),
    backPeaks: peaks(110, 520),
    frontPeaks: peaks(80, 390),
  }
}

export function pendingTodoWallpaperItems(items: TodoItem[], limit = 6): TodoItem[] {
  return items
    .filter((item) => item.status === 'pending')
    .sort((left, right) => (left.dueAt || '9999').localeCompare(right.dueAt || '9999'))
    .slice(0, Math.max(0, limit))
}

function escapeWallpaperXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 纯 SVG 生成，不读取文件、不修改系统壁纸，便于安全回归。 */
export function buildDesktopTodoWallpaperSvg(items: TodoItem[], generatedAt = new Date()): string {
  const theme = dailyTodoWallpaperTheme(generatedAt)
  const pending = pendingTodoWallpaperItems(items, 8)
  const lines = pending.length > 0
    ? pending.map((item, index) => `<text x="170" y="${430 + index * 74}" font-size="34" fill="#f8fafc"><tspan fill="#93c5fd">${index + 1}.</tspan> ${escapeWallpaperXml(item.title.slice(0, 30))}</text>`).join('')
    : '<text x="170" y="500" font-size="46" fill="#f8fafc">今日无待办，去看看远方吧</text><text x="170" y="570" font-size="28" fill="#dbeafe">No tasks. Make room for wonder.</text>'
  const mountain = (baseline: number, peaks: number[]) => [
    `0,1600 0,${baseline}`,
    ...peaks.map((height, index) => `${Math.round(index * (2560 / (peaks.length - 1)))},${baseline - height}`),
    '2560,1600',
  ].join(' ')
  const [skyTop, skyMiddle, skyBottom] = theme.palette
  return `<svg xmlns="http://www.w3.org/2000/svg" width="2560" height="1600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${skyTop}"/><stop offset=".48" stop-color="${skyMiddle}"/><stop offset="1" stop-color="${skyBottom}"/></linearGradient><filter id="b"><feGaussianBlur stdDeviation="60"/></filter></defs><rect width="2560" height="1600" fill="url(#g)"/><circle cx="${Math.round(theme.sunX * 1.75)}" cy="${Math.round(theme.sunY * .72)}" r="250" fill="#ffffff" opacity=".2" filter="url(#b)"/><polygon points="${mountain(1230, theme.backPeaks)}" fill="rgba(15,23,42,.28)"/><polygon points="${mountain(1420, theme.frontPeaks)}" fill="rgba(15,23,42,.55)"/><text x="170" y="230" font-size="34" fill="#dbeafe">CIPHERTALK · ${theme.dayKey}</text><text x="170" y="330" font-size="72" font-weight="700" fill="#ffffff">${pending.length > 0 ? '今日要紧的事' : '今日，轻装前行'}</text>${lines}<text x="170" y="1530" font-size="25" fill="#f8fafc" opacity=".72">由 CipherTalk 在本地生成 · 待办信息不会写入图片元数据</text></svg>`
}
