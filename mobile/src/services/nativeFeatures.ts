import { Calendar } from '@capacitor/calendar'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { LocalNotifications } from '@capacitor/local-notifications'
import { Preferences } from '@capacitor/preferences'
import { Share } from '@capacitor/share'
import type { TodoItem } from '../../../src/types/todo'
import { BRAND } from '../../../src/shared/brand'
import { todoCalendarEndTime } from '../../../src/shared/todoCalendar'
import { dailyTodoWallpaperTheme, pendingTodoWallpaperItems, todoWallpaperDateLabel, todoWallpaperDayKey } from '../../../src/shared/todoWallpaper'

const WALLPAPER_DAY_KEY = 'ciphertalk.todo.wallpaper.day.v1'

interface CipherWallpaperPlugin {
  setWallpaper(options: { base64: string }): Promise<void>
  scheduleWallpapers(options: { entries: Array<{ dayKey: string; base64: string }> }): Promise<void>
}

const CipherWallpaper = registerPlugin<CipherWallpaperPlugin>('CipherWallpaper')

function notificationId(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash | 0) || 1
}

export async function scheduleTodoNotifications(items: TodoItem[], remindBeforeMinutes: number): Promise<number> {
  const notifications = items
    .filter((item) => item.status === 'pending' && item.dueAt)
    .map((item) => ({ item, at: new Date(new Date(item.dueAt!).getTime() - remindBeforeMinutes * 60_000) }))
    .filter(({ at }) => at.getTime() > Date.now())
    .slice(0, 60)
    .map(({ item, at }) => ({
      id: notificationId(item.id),
      title: '待办快到时间了',
      body: item.title,
      schedule: { at, allowWhileIdle: true },
      extra: { ciphertalkTodoId: item.id },
    }))
  if (notifications.length) {
    const permission = await LocalNotifications.requestPermissions()
    if (permission.display !== 'granted') throw new Error('未获得系统通知权限')
  }
  const pending = await LocalNotifications.getPending()
  const ours = pending.notifications.filter((notification) => Boolean(notification.extra?.ciphertalkTodoId))
  if (ours.length) await LocalNotifications.cancel({ notifications: ours.map(({ id }) => ({ id })) })
  if (!notifications.length) return 0
  await LocalNotifications.schedule({ notifications })
  return notifications.length
}

export async function addTodoToCalendar(item: TodoItem, remindBeforeMinutes: number): Promise<void> {
  const startDate = item.dueAt ? new Date(item.dueAt).getTime() : Date.now() + 60 * 60_000
  await Calendar.createEventInteractively({
    title: item.title,
    notes: [item.details, item.sourceLabel ? `来源：${item.sourceLabel}` : ''].filter(Boolean).join('\n'),
    startDate,
    endDate: todoCalendarEndTime(startDate, item.endAt),
    firstReminderMinutes: remindBeforeMinutes,
  })
}

function drawWallpaper(items: TodoItem[], generatedAt = new Date()): string {
  const canvas = document.createElement('canvas')
  canvas.width = 1440
  canvas.height = 3200
  const context = canvas.getContext('2d')!
  const now = generatedAt
  const day = now.getDate()
  const theme = dailyTodoWallpaperTheme(now)
  const active = pendingTodoWallpaperItems(items)
  const palette = theme.palette
  const sky = context.createLinearGradient(0, 0, 0, canvas.height)
  sky.addColorStop(0, palette[0])
  sky.addColorStop(.52, palette[1])
  sky.addColorStop(1, palette[2])
  context.fillStyle = sky
  context.fillRect(0, 0, canvas.width, canvas.height)

  context.globalAlpha = .22
  context.fillStyle = '#ffffff'
  context.beginPath()
  context.arc(theme.sunX, theme.sunY, 250, 0, Math.PI * 2)
  context.fill()
  context.globalAlpha = 1

  const mountain = (baseline: number, color: string, peaks: number[]) => {
    context.fillStyle = color
    context.beginPath()
    context.moveTo(0, canvas.height)
    context.lineTo(0, baseline)
    peaks.forEach((height, index) => context.lineTo(index * (canvas.width / (peaks.length - 1)), baseline - height))
    context.lineTo(canvas.width, canvas.height)
    context.closePath()
    context.fill()
  }
  mountain(2500, 'rgba(15,23,42,.28)', theme.backPeaks)
  mountain(2780, 'rgba(15,23,42,.52)', theme.frontPeaks)

  context.fillStyle = '#ffffff'
  context.font = '700 58px -apple-system, BlinkMacSystemFont, sans-serif'
  context.fillText(`${BRAND.name.toUpperCase()} · TODAY`, 100, 180)
  context.font = '800 132px -apple-system, BlinkMacSystemFont, sans-serif'
  context.fillText(todoWallpaperDateLabel(now), 94, 370)
  context.font = '500 42px -apple-system, BlinkMacSystemFont, sans-serif'
  context.globalAlpha = .78
  context.fillText(active.length ? '重要的事，一件一件来。' : '今天没有待办，去看看风景吧。', 100, 455)
  context.globalAlpha = 1

  active.forEach((item, index) => {
    const y = 720 + index * 250
    context.fillStyle = 'rgba(255,255,255,.13)'
    context.beginPath()
    context.roundRect(90, y - 100, 1260, 190, 38)
    context.fill()
    context.strokeStyle = 'rgba(255,255,255,.62)'
    context.lineWidth = 4
    context.beginPath()
    context.roundRect(135, y - 30, 40, 40, 12)
    context.stroke()
    context.fillStyle = '#ffffff'
    context.font = '650 48px -apple-system, BlinkMacSystemFont, sans-serif'
    const title = item.title.length > 22 ? `${item.title.slice(0, 22)}…` : item.title
    context.fillText(title, 220, y + 8)
    context.globalAlpha = .72
    context.font = '400 32px -apple-system, BlinkMacSystemFont, sans-serif'
    context.fillText(item.dueAt ? new Date(item.dueAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '未设时间', 220, y + 60)
    context.globalAlpha = 1
  })
  return canvas.toDataURL('image/png').split(',')[1]
}

async function writeWallpaper(items: TodoItem[]): Promise<string> {
  const day = todoWallpaperDayKey()
  const path = `wallpapers/ciphertalk-${day}.png`
  await Filesystem.writeFile({ path, directory: Directory.Cache, data: drawWallpaper(items), recursive: true })
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache })
  return uri
}

export async function prepareDailyWallpaper(items: TodoItem[], applyOnAndroid = false, forceSchedule = false): Promise<void> {
  const day = todoWallpaperDayKey()
  const current = await Preferences.get({ key: WALLPAPER_DAY_KEY })
  if (current.value !== day || forceSchedule) {
    const base64 = drawWallpaper(items)
    const path = `wallpapers/ciphertalk-${day}.png`
    // Android 必须先真正应用成功再写日期；失败时保留重试机会。
    if (applyOnAndroid && Capacitor.getPlatform() === 'android') {
      const entries = Array.from({ length: 8 }, (_, offset) => {
        const date = new Date()
        date.setHours(12, 0, 0, 0)
        date.setDate(date.getDate() + offset)
        return { dayKey: todoWallpaperDayKey(date), base64: drawWallpaper(items, date) }
      })
      await CipherWallpaper.scheduleWallpapers({ entries })
    }
    await Filesystem.writeFile({ path, directory: Directory.Cache, data: base64, recursive: true })
    await Preferences.set({ key: WALLPAPER_DAY_KEY, value: day })
  }
}

export async function applyDailyWallpaper(items: TodoItem[]): Promise<'applied' | 'shared'> {
  if (Capacitor.getPlatform() !== 'android') {
    await shareDailyWallpaper(items)
    return 'shared'
  }
  const base64 = drawWallpaper(items)
  await CipherWallpaper.setWallpaper({ base64 })
  await Preferences.set({ key: WALLPAPER_DAY_KEY, value: todoWallpaperDayKey() })
  return 'applied'
}

export async function shareDailyWallpaper(items: TodoItem[]): Promise<void> {
  const uri = await writeWallpaper(items)
  await Share.share({
    title: `${BRAND.displayName} 今日待办壁纸`,
    text: '保存图片后可在系统中设为锁屏或桌面壁纸。',
    url: uri,
    dialogTitle: '保存或设置今日壁纸',
  })
  await Preferences.set({ key: WALLPAPER_DAY_KEY, value: todoWallpaperDayKey() })
}
