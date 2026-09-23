import assert from 'node:assert/strict'
import sharp from 'sharp'
import { buildDesktopTodoWallpaperSvg, dailyTodoWallpaperTheme, pendingTodoWallpaperItems, todoWallpaperDateLabel, todoWallpaperDayKey } from '../src/shared/todoWallpaper.ts'
import type { TodoItem } from '../src/types/todo.ts'

assert.equal(todoWallpaperDayKey(new Date(2026, 7, 31, 0, 5)), '2026-08-31', '壁纸日期必须使用设备本地日历日')
assert.equal(todoWallpaperDayKey(new Date(2026, 8, 1, 0, 5)), '2026-09-01', '跨月日期必须正确')
assert.equal(todoWallpaperDateLabel(new Date(2026, 7, 31, 23, 59)), '8月31日')
assert.equal(todoWallpaperDateLabel(new Date(2026, 8, 1, 0, 1)), '9月1日', '预生成的跨月移动壁纸必须使用目标日期月份')

const first = dailyTodoWallpaperTheme(new Date(2026, 7, 31, 9, 0))
const sameDay = dailyTodoWallpaperTheme(new Date(2026, 7, 31, 22, 0))
const nextDay = dailyTodoWallpaperTheme(new Date(2026, 8, 1, 9, 0))
assert.deepEqual(first, sameDay, '同一天必须生成稳定壁纸，避免重复打开时闪烁')
assert.notDeepEqual(first, nextDay, '相邻日期必须生成不同风景构图')

const base = {
  details: '',
  dueAt: null,
  priority: 'medium',
  sourceType: 'manual',
  sourceLabel: '测试',
  sourceRef: 'test',
  sourcePreview: '',
  confidence: 1,
  createdAt: 1,
  updatedAt: 1,
} as const
const items: TodoItem[] = [
  { ...base, id: 'completed', title: '已完成', status: 'completed' },
  { ...base, id: 'dismissed', title: '已忽略', status: 'dismissed' },
]
assert.equal(pendingTodoWallpaperItems(items).length, 0, '只有已完成/已忽略事项时必须进入风景兜底')
items.push({ ...base, id: 'pending', title: '待处理', status: 'pending' })
assert.deepEqual(pendingTodoWallpaperItems(items).map((item) => item.id), ['pending'], '壁纸只能展示待处理事项')

const scenicSvg = buildDesktopTodoWallpaperSvg(items.filter((item) => item.status !== 'pending'), new Date(2026, 7, 31, 9, 0))
assert.match(scenicSvg, /今日无待办，去看看远方吧/)
assert.doesNotMatch(scenicSvg, /已完成/)
const todoSvg = buildDesktopTodoWallpaperSvg(items, new Date(2026, 7, 31, 9, 0))
assert.match(todoSvg, /待处理/)
const rendered = await sharp(Buffer.from(todoSvg)).png().toBuffer({ resolveWithObject: true })
assert.equal(rendered.info.width, 2560)
assert.equal(rendered.info.height, 1600)
assert.equal(rendered.info.format, 'png')

console.log('mobile daily wallpaper planning tests passed')
