import { useEffect, useMemo, useState } from 'react'
import { Button, toast } from '@heroui/react'
import {
  Bell,
  Calendar,
  Check,
  CircleCheck,
  Cloud,
  CloudCheck,
  Clock,
  Envelope,
  Link,
  ListCheck,
  MagicWand,
  Picture,
  Plus,
  ShieldKeyhole,
  Sparkles,
  TrashBin,
} from '@gravity-ui/icons'
import { useNavigate } from 'react-router-dom'
import type { TodoDashboardState, TodoItem, TodoMailProvider, TodoMailViewerMessage, TodoPriority, TodoStatus } from '../types/todo'
import { todoPlatform } from '../services/todoPlatform'
import * as configService from '../services/config'
import { formatTodoScanCost } from '../shared/todoScanUsage'
import { compareTodoImportance } from '../shared/todoIntelligence'
import {
  AWS_BEDROCK_MANTLE_DEFAULT_MODEL,
  AWS_BEDROCK_MANTLE_DIRECT_BASE_URL,
  AWS_BEDROCK_MANTLE_PROVIDER_ID,
} from '../shared/awsBedrockMantle'
import { getTodoMailGuide } from '../shared/todoMailGuide'
import { BRAND } from '../shared/brand'
import { todoDecisionRequiresApiKey, type TodoJevConfigState } from '../shared/todoJevConfig'
import TodoJevSettings from '../components/TodoJevSettings'
import './TodoPage.css'

type Filter = 'today' | 'upcoming' | 'completed' | 'feedback' | 'all'

const priorityLabel: Record<TodoPriority, string> = {
  high: '高优先级',
  medium: '中优先级',
  low: '低优先级',
}

const mailPresets: Record<Exclude<TodoMailProvider, 'custom'>, { host: string; port: number; secure: boolean; name: string; web: string; help: string }> = {
  gmail: { host: 'imap.gmail.com', port: 993, secure: true, name: 'Gmail', web: 'https://mail.google.com/', help: 'https://myaccount.google.com/apppasswords' },
  outlook: { host: 'outlook.office365.com', port: 993, secure: true, name: 'Outlook', web: 'https://outlook.live.com/mail/', help: 'https://support.microsoft.com/account-billing/using-app-passwords-with-apps-that-don-t-support-two-step-verification-5896ed9b-4263-e681-128a-a6f2979a7944' },
  icloud: { host: 'imap.mail.me.com', port: 993, secure: true, name: 'iCloud 邮箱', web: 'https://www.icloud.com/mail/', help: 'https://support.apple.com/102654' },
  yahoo: { host: 'imap.mail.yahoo.com', port: 993, secure: true, name: 'Yahoo 邮箱', web: 'https://mail.yahoo.com/', help: 'https://help.yahoo.com/kb/generate-manage-third-party-passwords-sln15241.html' },
  qq: { host: 'imap.qq.com', port: 993, secure: true, name: 'QQ 邮箱', web: 'https://mail.qq.com/', help: 'https://wx.mail.qq.com/account' },
  '163': { host: 'imap.163.com', port: 993, secure: true, name: '163 邮箱', web: 'https://mail.163.com/', help: 'https://mail.163.com/' },
}

function formatDue(value: string | null): string {
  if (!value) return '未设定时间'
  const date = new Date(value)
  const today = new Date()
  const tomorrow = new Date(today)
  tomorrow.setDate(today.getDate() + 1)
  const prefix = date.toDateString() === today.toDateString()
    ? '今天'
    : date.toDateString() === tomorrow.toDateString()
      ? '明天'
      : `${date.getMonth() + 1}月${date.getDate()}日`
  return `${prefix} ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
}

function sourceName(item: TodoItem): string {
  if (item.sourceType === 'wechat') return '微信'
  if (item.sourceType === 'gmail') return 'Gmail'
  if (item.sourceType === 'imap') return '邮箱'
  if (item.sourceType === 'drive') return 'Drive'
  return '手动'
}

function isToday(value: string | null): boolean {
  if (!value) return false
  return new Date(value).toDateString() === new Date().toDateString()
}

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`
}

function formatReminder(minutes: number): string {
  if (minutes === 0) return '事项开始时'
  if (minutes < 60) return `提前 ${minutes} 分钟`
  if (minutes % (24 * 60) === 0) return `提前 ${minutes / (24 * 60)} 天`
  if (minutes % 60 === 0) return `提前 ${minutes / 60} 小时`
  return `提前 ${minutes} 分钟`
}

function formatSchedule(item: TodoItem): string {
  const start = formatDue(item.dueAt)
  if (!item.dueAt || !item.endAt || Date.parse(item.endAt) <= Date.parse(item.dueAt)) return start
  const end = new Date(item.endAt)
  if (!Number.isFinite(end.getTime())) return start
  return `${start}–${new Date(item.dueAt).toDateString() === end.toDateString()
    ? end.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : formatDue(item.endAt)}`
}

function reminderTimeLabel(item: TodoItem, minutes: number): string {
  const timestamp = Date.parse(item.dueAt || '')
  return Number.isFinite(timestamp) && Number.isFinite(minutes)
    ? formatDue(new Date(timestamp - minutes * 60_000).toISOString()) : '时间待确认'
}

function evidenceDateLabel(item: TodoItem): string {
  const evidence = item.evidence
  if (!evidence) return ''
  if (evidence.dateStatus === 'user-confirmed') return item.dueAt ? `你设置的时间：${formatDue(item.dueAt)}` : '你已清除提醒时间'
  if (evidence.dateStatus === 'exact') return `已识别时间：${item.dueAt ? formatSchedule(item) : evidence.date || '请核对原文'}`
  if (evidence.dateStatus === 'date-only') return `已识别日期：${evidence.date || evidence.dateQuote || '见原文'} · 具体时间待确认`
  if (evidence.dateStatus === 'unconfirmed') return '日期待确认 · 暂不设置自动提醒'
  return '原文未识别到明确日期'
}

function recordedCount(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '未记录'
}

function localDateInput(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (number: number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function TodoPage() {
  const navigate = useNavigate()
  const [state, setState] = useState<TodoDashboardState | null>(null)
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [filter, setFilter] = useState<Filter>('today')
  const [showCreate, setShowCreate] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDueAt, setNewDueAt] = useState('')
  const [newPriority, setNewPriority] = useState<TodoPriority>('medium')
  const [showMailSetup, setShowMailSetup] = useState(true)
  const [mailProvider, setMailProvider] = useState<TodoMailProvider>('gmail')
  const [mailEmail, setMailEmail] = useState('')
  const [mailPassword, setMailPassword] = useState('')
  const [mailHost, setMailHost] = useState('')
  const [mailPort, setMailPort] = useState(993)
  const [mailSecure, setMailSecure] = useState(true)
  const [mailConnecting, setMailConnecting] = useState(false)
  const [showGoogleSetup, setShowGoogleSetup] = useState(false)
  const [googleClientId, setGoogleClientId] = useState('')
  const [googleClientSecret, setGoogleClientSecret] = useState('')
  const [googleConnecting, setGoogleConnecting] = useState(false)
  const [mailInboxOpen, setMailInboxOpen] = useState(false)
  const [mailInboxLoading, setMailInboxLoading] = useState(false)
  const [mailInboxLabel, setMailInboxLabel] = useState('收件箱')
  const [mailInboxMessages, setMailInboxMessages] = useState<TodoMailViewerMessage[]>([])
  const [selectedMailId, setSelectedMailId] = useState('')
  const [showSyncSetup, setShowSyncSetup] = useState(false)
  const [syncEndpoint, setSyncEndpoint] = useState('')
  const [syncUsername, setSyncUsername] = useState('')
  const [syncPassword, setSyncPassword] = useState('')
  const [syncRemotePath, setSyncRemotePath] = useState('CipherTalk/todos.enc.json')
  const [syncSecret, setSyncSecret] = useState('')
  const [syncAuto, setSyncAuto] = useState(true)
  const [syncSourcePreview, setSyncSourcePreview] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [generatedSecret, setGeneratedSecret] = useState('')
  const [profileDraft, setProfileDraft] = useState<{ personalContext: string; learningEnabled: boolean } | null>(null)
  const [profileSaving, setProfileSaving] = useState(false)
  const [feedbackSavingId, setFeedbackSavingId] = useState<string | null>(null)
  const [jevConfig, setJevConfig] = useState<TodoJevConfigState | null>(null)
  const [dueEditor, setDueEditor] = useState<{ id: string; value: string } | null>(null)
  const [dueSaving, setDueSaving] = useState(false)

  const reload = async () => {
    const next = await todoPlatform.getState()
    setState(next)
    setSyncEndpoint((current) => current || next.sync.endpoint)
    setSyncUsername((current) => current || next.sync.username)
    setSyncRemotePath((current) => current === 'CipherTalk/todos.enc.json' ? (next.sync.remotePath || current) : current)
    setSyncAuto(next.sync.autoSync)
    setSyncSourcePreview(next.sync.includeSourcePreview)
    setGoogleClientId((current) => current || next.google.clientId)
    setLoading(false)
  }

  useEffect(() => {
    void reload()
  }, [])

  const pending = useMemo(() => state?.items.filter((item) => item.status === 'pending') || [], [state])
  const visibleItems = useMemo(() => {
    const items = [...(state?.items || [])].sort(compareTodoImportance)
    if (filter === 'completed') return items.filter((item) => item.status === 'completed')
    if (filter === 'feedback') return items.filter((item) => Boolean(item.feedback) || item.status === 'dismissed')
    if (filter === 'today') return items.filter((item) => item.status === 'pending' && (isToday(item.dueAt) || !item.dueAt))
    if (filter === 'upcoming') return items.filter((item) => item.status === 'pending' && item.dueAt && !isToday(item.dueAt))
    return items
  }, [filter, state])
  const selectedMail = useMemo(
    () => mailInboxMessages.find((message) => message.id === selectedMailId) || mailInboxMessages[0] || null,
    [mailInboxMessages, selectedMailId],
  )

  const applyLocalAwsProxy = async () => {
    try {
      const imported = await window.electronAPI.ai.importLocalAwsProxy()
      if (!imported.success || !imported.apiKey) {
        toast.danger(imported.error || '本机没有找到 CC-Switch 的 AWS 密钥')
        navigate('/settings?tab=ai&from=todo')
        return
      }
      await configService.setAiProvider(AWS_BEDROCK_MANTLE_PROVIDER_ID)
      await configService.setAiProviderConfig(AWS_BEDROCK_MANTLE_PROVIDER_ID, {
        apiKey: imported.apiKey,
        model: imported.model || AWS_BEDROCK_MANTLE_DEFAULT_MODEL,
        baseURL: imported.baseURL || AWS_BEDROCK_MANTLE_DIRECT_BASE_URL,
        protocol: 'openai-compatible',
      })
      toast.success(`已接入 ${imported.source || 'AWS Bedrock'}，将用 ${imported.model || AWS_BEDROCK_MANTLE_DEFAULT_MODEL} 分析消息`)
      await reload()
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : '导入 AWS 代理失败')
    }
  }

  const handleScan = async () => {
    if (jevConfig?.enabled && todoDecisionRequiresApiKey(jevConfig.backend, jevConfig.endpoint) && !jevConfig.hasApiKey) {
      toast.danger('请展开本地判断模型设置，填写该远程服务专用的 API Key')
      return
    }
    if (!state?.aiConfigured) {
      toast.danger(jevConfig?.enabled ? '判断模型未就绪，请展开本地判断模型检查配置' : '请先配置分析服务；也可以展开本地判断模型，连接无需云端密钥的 Laya')
      if (!jevConfig?.enabled) navigate('/settings?tab=ai&from=todo')
      return
    }
    setScanning(true)
    try {
      const result = await todoPlatform.scan(true)
      if (result.partial) {
        toast.info(`已处理可用来源：分析 ${result.analyzedMessages || 0} 条，新增 ${result.addedTodos || 0} 个；失败来源将在 15 分钟后重试。${result.error ? ` ${result.error}` : ''}`)
      } else if (result.success) {
        toast.success(`已分析 ${result.analyzedMessages || 0} 条候选消息，新增 ${result.addedTodos || 0} 条重要信息与待办`)
      } else {
        toast.danger(result.error || '扫描失败')
      }
      await reload()
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : '扫描失败')
    } finally {
      setScanning(false)
    }
  }

  const resetScan = async () => {
    if (scanning || resetting) return
    const confirmed = window.confirm('会清空自动提取的信息与待办、其反馈记录和消息指纹，方便重新扫描验证。手动补记会保留，邮箱和 API 配置不动。确定清除？')
    if (!confirmed) return
    setResetting(true)
    try {
      const result = await todoPlatform.resetScan()
      if (!result.success) {
        toast.danger(result.error || '清除失败')
        return
      }
      toast.success(`已清除 ${result.removedCount || 0} 条自动提取记录。现在可以再点「扫描今日消息」。`)
      await reload()
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : '清除失败')
    } finally {
      setResetting(false)
    }
  }

  const setStatus = async (item: TodoItem, status: TodoStatus) => {
    const result = await todoPlatform.update(item.id, { status })
    if (!result.success) {
      toast.danger(result.error || '更新失败')
      return
    }
    await reload()
  }

  const saveReminderTime = async (item: TodoItem, clear = false) => {
    if (dueSaving) return
    let dueAt: string | null = null
    if (!clear) {
      const value = dueEditor?.id === item.id ? dueEditor.value : ''
      const date = new Date(value)
      if (!value || Number.isNaN(date.getTime()) || localDateInput(date.toISOString()) !== value) {
        toast.danger('请选择有效的本地日期和时间')
        return
      }
      dueAt = date.toISOString()
    }
    setDueSaving(true)
    try {
      const result = await todoPlatform.update(item.id, { dueAt })
      if (!result.success) { toast.danger(result.error || '提醒时间保存失败'); return }
      setDueEditor(null)
      toast.success(clear ? '已清除提醒时间，原文证据保留' : state?.settings.reminderEnabled ? '已保存你确认的时间，将按当前提醒设置处理' : '已保存你确认的时间；系统提醒当前关闭，可在自动化中开启')
      await reload()
    } catch { toast.danger('提醒时间保存失败，请重试') }
    finally { setDueSaving(false) }
  }

  const remove = async (item: TodoItem) => {
    const result = await todoPlatform.remove(item.id)
    if (!result.success) {
      toast.danger('删除失败')
      return
    }
    await reload()
  }

  const markFeedback = async (item: TodoItem, vote: 'useful' | 'useless' | null) => {
    if (feedbackSavingId) return
    setFeedbackSavingId(item.id)
    try {
      const result = await todoPlatform.recordFeedback(item.id, vote)
      if (!result.success) {
        toast.danger(result.error || '反馈保存失败')
        return
      }
      toast.success(vote === null ? '已撤销反馈' : vote === 'useful' ? '已记住：这类消息对你有用' : '已记住：这类消息以后少提，可在「反馈记录」中撤销')
      await reload()
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : '反馈保存失败')
    } finally {
      setFeedbackSavingId(null)
    }
  }

  const saveProfile = async () => {
    if (!profileDraft || profileSaving) return
    setProfileSaving(true)
    try {
      const result = await todoPlatform.updateSettings(profileDraft)
      if (!result.success) {
        toast.danger(result.error || '关注说明保存失败')
        return
      }
      setState((current) => current ? { ...current, settings: result.settings || { ...current.settings, ...profileDraft } } : current)
      setProfileDraft(null)
      toast.success('关注说明已保存，将用于下一次消息分析')
      await reload()
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : '关注说明保存失败')
    } finally {
      setProfileSaving(false)
    }
  }

  const createTodo = async () => {
    if (!newTitle.trim()) {
      toast.danger('请先填写待办内容')
      return
    }
    const result = await todoPlatform.create({
      title: newTitle,
      dueAt: newDueAt ? new Date(newDueAt).toISOString() : null,
      priority: newPriority,
      sourceLabel: '手动补记（漏检反馈）',
    })
    if (!result.success) {
      toast.danger(result.error || '创建失败')
      return
    }
    setNewTitle('')
    setNewDueAt('')
    setNewPriority('medium')
    setShowCreate(false)
    await reload()
  }

  const updateSettings = async (patch: Partial<TodoDashboardState['settings']>) => {
    if (!state) return
    const optimistic = { ...state, settings: { ...state.settings, ...patch } }
    setState(optimistic)
    const result = await todoPlatform.updateSettings(patch)
    if (!result.success) {
      toast.danger(result.error || '设置保存失败')
      await reload()
    }
  }

  const updateSourceEnabled = async (type: 'wechat', enabled: boolean) => {
    if (!state) return
    const existing = state.settings.connectors.find((connector) => connector.type === type)
    const connectors = existing
      ? state.settings.connectors.map((connector) => connector.type === type ? { ...connector, enabled } : connector)
      : [...state.settings.connectors, {
        id: 'wechat-local',
        type,
        name: '微信本地消息',
        enabled,
        status: 'connected' as const,
      }]
    await updateSettings({ connectors })
  }

  const exportCalendar = async () => {
    const result = await todoPlatform.exportCalendar()
    if (result.success) toast.success('已导出 iCalendar，可导入苹果、谷歌或 Outlook 日历')
    else if (!result.canceled) toast.danger(result.error || '导出失败')
  }

  const addToCalendar = async (item: TodoItem) => {
    const result = await todoPlatform.addToCalendar(item.id)
    if (result.success) toast.success('已打开系统日历，请确认导入')
    else toast.danger(result.error || '打开日历失败')
  }

  const applyWallpaper = async () => {
    const result = await todoPlatform.applyWallpaper()
    if (result.success) toast.success('今日待办壁纸已应用')
    else toast.danger(result.error || '更换壁纸失败')
  }

  const openWebmail = async (url: string, title: string) => {
    await todoPlatform.openWeb(url, title)
  }

  const connectMail = async () => {
    const preset = mailProvider === 'custom' ? null : mailPresets[mailProvider]
    const host = preset?.host || mailHost.trim()
    const port = preset?.port || mailPort
    const secure = preset?.secure ?? mailSecure
    if (!mailEmail.trim() || !mailPassword || !host || !Number.isInteger(port) || port < 1 || port > 65535) {
      toast.danger('请填写邮箱、IMAP 地址和应用专用密码')
      return
    }
    setMailConnecting(true)
    try {
      const result = await todoPlatform.addMailAccount({
        provider: mailProvider,
        name: preset?.name || mailEmail,
        email: mailEmail,
        host,
        port,
        secure,
        password: mailPassword,
      })
      if (!result.success) {
        toast.danger(result.error || '邮箱连接失败')
        return
      }
      toast.success('邮箱已连接，下次扫描会一并分析今日邮件')
      setMailPassword('')
      setShowMailSetup(false)
      await reload()
    } finally {
      setMailConnecting(false)
    }
  }

  const removeMailAccount = async (id: string) => {
    const result = await todoPlatform.removeMailAccount(id)
    if (result.success) await reload()
    else toast.danger('移除邮箱失败')
  }

  const viewMailInbox = async (accountId: string, label: string) => {
    setMailInboxOpen(true)
    setMailInboxLoading(true)
    setMailInboxLabel(label)
    setMailInboxMessages([])
    setSelectedMailId('')
    try {
      const result = await todoPlatform.listMailInbox(accountId, 30)
      if (!result.success || !result.messages) {
        toast.danger(result.error || '收件箱读取失败')
        setMailInboxOpen(false)
        return
      }
      setMailInboxLabel(result.accountLabel || label)
      setMailInboxMessages(result.messages)
      setSelectedMailId(result.messages[0]?.id || '')
    } finally {
      setMailInboxLoading(false)
    }
  }

  const connectGoogle = async () => {
    if (!googleClientId.trim()) {
      toast.danger('请填写 Google 桌面应用 OAuth 客户端 ID')
      return
    }
    setGoogleConnecting(true)
    try {
      const result = await todoPlatform.connectGoogle({
        clientId: googleClientId,
        clientSecret: googleClientSecret || undefined,
      })
      if (!result.success) {
        toast.danger(result.error || 'Google 连接失败')
        return
      }
      setGoogleClientSecret('')
      setShowGoogleSetup(false)
      toast.success('Gmail 与 Drive 已以只读方式连接')
      await reload()
    } finally {
      setGoogleConnecting(false)
    }
  }

  const disconnectGoogle = async () => {
    if (!window.confirm('确定从本机移除 Google 访问令牌吗？不会删除或修改任何 Gmail / Drive 内容。')) return
    await todoPlatform.disconnectGoogle()
    setGoogleClientSecret('')
    await reload()
  }

  const configureSync = async () => {
    if (!syncEndpoint.trim() || !syncUsername.trim() || (!state?.sync.configured && !syncPassword)) {
      toast.danger('请填写 WebDAV 地址、用户名和密码')
      return
    }
    setSyncing(true)
    try {
      const configured = await todoPlatform.configureSync({
        endpoint: syncEndpoint,
        username: syncUsername,
        password: syncPassword || undefined,
        remotePath: syncRemotePath,
        secret: syncSecret || undefined,
        autoSync: syncAuto,
        includeSourcePreview: syncSourcePreview,
        enabled: true,
      })
      if (!configured.success) {
        toast.danger(configured.error || '同步配置保存失败')
        return
      }
      setSyncPassword('')
      setSyncSecret('')
      if (configured.generatedSecret) setGeneratedSecret(configured.generatedSecret)
      const result = await todoPlatform.syncNow()
      if (result.success) {
        toast.success(`加密同步完成，共 ${result.mergedItems || 0} 个待办`)
        setShowSyncSetup(false)
      } else {
        toast.danger(result.error || 'WebDAV 连接失败，请检查地址和凭据')
      }
      await reload()
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : '同步失败')
    } finally {
      setSyncing(false)
    }
  }

  const syncNow = async () => {
    setSyncing(true)
    try {
      const result = await todoPlatform.syncNow()
      if (result.success) toast.success(`同步完成，共 ${result.mergedItems || 0} 个待办`)
      else toast.danger(result.error || '同步失败')
      await reload()
    } finally {
      setSyncing(false)
    }
  }

  const disconnectSync = async () => {
    if (!window.confirm('断开后本机将删除 WebDAV 密码和同步密钥；远端密文文件不会删除。确定继续吗？')) return
    await todoPlatform.disconnectSync()
    setGeneratedSecret('')
    setSyncEndpoint('')
    setSyncUsername('')
    setSyncPassword('')
    setSyncSecret('')
    setShowSyncSetup(false)
    await reload()
  }

  const copyGeneratedSecret = async () => {
    await navigator.clipboard.writeText(generatedSecret)
    toast.success('恢复密钥已复制；请保存在密码管理器中')
  }

  if (loading || !state) {
    return (
      <div className="todo-page todo-page--loading">
        <span className="todo-loading-orb" />
        <p>正在整理今天的信息…</p>
      </div>
    )
  }

  const completedToday = state.items.filter((item) => item.status === 'completed' && new Date(item.updatedAt).toDateString() === new Date().toDateString()).length
  const urgent = pending.filter((item) => item.priority === 'high').length
  // Reloads update the dashboard, while this independent draft stays untouched.
  const profileForm = profileDraft || {
    personalContext: state.settings.personalContext || '',
    learningEnabled: state.settings.learningEnabled !== false,
  }

  return (
    <div className="todo-page">
      <div className="todo-aurora todo-aurora--one" />
      <div className="todo-aurora todo-aurora--two" />
      <header className="todo-hero">
        <div>
          <div className="todo-eyebrow"><Sparkles width={15} height={15} /> {BRAND.name} · 信息助手</div>
          <h1>把注意力留给<br />真正重要的事。</h1>
          <p>从微信和邮件中整理值得关注的消息，用你的反馈，逐渐学会轻重缓急。</p>
        </div>
        <div className="todo-hero-actions">
          <Button variant="primary" size="lg" onPress={handleScan} isPending={scanning}>
            <MagicWand width={19} height={19} />
            {scanning ? '正在分析…' : '扫描今日消息'}
          </Button>
          <button className="todo-reset-scan" onClick={() => void resetScan()} disabled={scanning || resetting}>
            {resetting ? '正在清除…' : '清除扫描记录'}
          </button>
          <span>{state.scan.lastSuccessfulScanAt ? `上次成功 ${new Date(state.scan.lastSuccessfulScanAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '尚未运行首次扫描'}</span>
        </div>
      </header>

      <section className="todo-api-banner">
        <div className="todo-api-icon"><Sparkles width={23} height={23} /></div>
        <div>
          <strong>{jevConfig?.enabled ? `当前使用 ${jevConfig.backend === 'laya' ? 'Laya 本地模型' : 'Jev 判断模式'}` : state.aiConfigured ? '更换或重新导入 AI' : '再一步就可以开始'}</strong>
          <p>{jevConfig?.enabled ? '扫描使用下方独立配置的判断接口，不会调用通用云端 AI。Laya 结果均保留供人工核对，服务不可用时不会自动回退到云端。' : '配置 AI 服务商即可开始分析，也可使用下方的 Laya 本地判断模型（无需云端 API Key）。如果本机已安装 CC-Switch，可尝试导入 AWS 配置。'}</p>
        </div>
        {!jevConfig?.enabled && <div className="todo-api-banner-actions">
          <button onClick={() => void applyLocalAwsProxy()}>使用本机 AWS 代理</button>
          <button onClick={() => navigate('/settings?tab=ai&from=todo')}>打开 AI 设置 <span>→</span></button>
        </div>}
      </section>
      <TodoJevSettings onStateChange={setJevConfig} onSaved={reload} disabled={scanning || state.scanning} />

      <section className="todo-stats" aria-label="待办概览">
        <div><span className="todo-stat-icon todo-stat-icon--blue"><ListCheck /></span><p>待处理</p><strong>{pending.length}</strong><small>个事项</small></div>
        <div><span className="todo-stat-icon todo-stat-icon--amber"><Clock /></span><p>高优先级</p><strong>{urgent}</strong><small>需留意</small></div>
        <div><span className="todo-stat-icon todo-stat-icon--green"><CircleCheck /></span><p>今日处理</p><strong>{completedToday}</strong><small>已放心</small></div>
        <div><span className="todo-stat-icon todo-stat-icon--violet"><Sparkles /></span><p>累计分析</p><strong>{state.scan.analyzedMessages}</strong><small>条候选</small></div>
      </section>
      <p className="todo-usage-line">
        上次扫描：缓存命中 {state.scan.lastCacheHits || 0} 条，实际发送 {state.scan.lastSentMessages || 0} 条。{formatTodoScanCost(state.scan.lastEstimatedCostUsd)}。成功分析过的消息按指纹跳过；重置或失败重试可能重新计费。
      </p>
      <div className="todo-decision-stats" aria-label="上次扫描判断统计">
        <span>判断方式 <strong>{state.scan.lastDecisionEngine === 'laya' ? 'Laya' : state.scan.lastDecisionEngine === 'jev' ? 'Jev' : state.scan.lastDecisionEngine === 'llm' ? '文本模型' : '未记录'}</strong></span>
        <span>判断请求 <strong>{recordedCount(state.scan.lastDecisionRequests)}</strong></span>
        <span>规则跳过 <strong>{recordedCount(state.scan.lastRuleSkipped)}</strong></span>
        <span>需核对事项 <strong>{recordedCount(state.scan.lastReviewItems)}</strong></span>
      </div>
      <section className="todo-profile todo-panel" aria-label="使用画像">
        <div>
          <span className="todo-section-kicker">PROFILE</span>
          <strong>它现在怎么理解你</strong>
          <p>{state.profile?.summary || '还在学习你的节奏。'}</p>
          {state.profile?.roles?.length ? (
            <div className="todo-profile-tags">
              {state.profile.roles.map((role) => <span key={role}>{role}</span>)}
            </div>
          ) : null}
        </div>
        <small>已记 {state.profile?.usefulCount || 0} 条有用 / {state.profile?.uselessCount || 0} 条没用</small>
        <details className="todo-profile-editor">
          <summary>让助手了解你{profileDraft && <span>有未保存的修改</span>}</summary>
          <div className="todo-profile-form">
            <label htmlFor="todo-personal-context">你的角色、目标与关注方向</label>
            <textarea
              id="todo-personal-context"
              value={profileForm.personalContext}
              onChange={(event) => setProfileDraft({ ...profileForm, personalContext: event.target.value })}
              maxLength={2000}
              disabled={profileSaving}
              aria-describedby="todo-profile-hint"
              placeholder="例如：我负责产品交付，关注客户反馈、项目截止时间与 AI 工具进展。"
            />
            <p id="todo-profile-hint">这些是你主动提供的说明。分析时会连同消息发送给当前所选的判断服务（本机 Laya、Jev 或 AI）；反馈只用于内容偏好，不据此猜测你的身份。</p>
            <label className="todo-learning-toggle">
              <input type="checkbox" checked={profileForm.learningEnabled} disabled={profileSaving} onChange={(event) => setProfileDraft({ ...profileForm, learningEnabled: event.target.checked })} />
              根据“有用／没用”反馈学习偏好
            </label>
            <small>暂停后保留已有反馈，后续分析不再根据反馈调整重要度。</small>
            <div className="todo-profile-actions">
              <button className="is-primary" onClick={() => void saveProfile()} disabled={!profileDraft || profileSaving}>{profileSaving ? '正在保存…' : '保存关注说明'}</button>
              {profileDraft && <button onClick={() => setProfileDraft(null)} disabled={profileSaving}>放弃修改</button>}
            </div>
          </div>
        </details>
      </section>

      <main className="todo-layout">
        <section className="todo-panel todo-list-panel">
          <div className="todo-panel-header">
            <div>
              <span className="todo-section-kicker">FOCUS</span>
              <h2>重要消息与待办</h2>
            </div>
            <button className="todo-add-button" onClick={() => setShowCreate((value) => !value)}><Plus width={17} height={17} /> 漏掉了？手动补记</button>
          </div>

          <div className="todo-filters">
            {([
              ['today', '今天'],
              ['upcoming', '之后'],
              ['completed', '已处理'],
              ['feedback', '反馈记录'],
              ['all', '全部'],
            ] as Array<[Filter, string]>).map(([key, label]) => (
              <button key={key} className={filter === key ? 'is-active' : ''} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>
            ))}
          </div>

          {showCreate && (
            <div className="todo-create-form">
              <input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="记下一件不能忘的事…" autoFocus />
              <div>
                <input type="datetime-local" value={newDueAt} onChange={(event) => setNewDueAt(event.target.value)} />
                <select value={newPriority} onChange={(event) => setNewPriority(event.target.value as TodoPriority)}>
                  <option value="high">高优先级</option>
                  <option value="medium">中优先级</option>
                  <option value="low">低优先级</option>
                </select>
                <button onClick={createTodo}><Check width={16} height={16} /> 保存</button>
              </div>
              <p>这条补记只作为你的待办保存，不会把反馈内容发送给 AI。</p>
            </div>
          )}

          <div className="todo-items">
            {visibleItems.length === 0 && (
              <div className="todo-empty">
                <span><CircleCheck width={32} height={32} /></span>
                <h3>{filter === 'feedback' ? '还没有反馈记录' : filter === 'completed' ? '还没有处理记录' : '这里已经清空了'}</h3>
                <p>{filter === 'feedback' ? '标记过有用或没用的消息会出现在这里，可以随时撤销。' : filter === 'completed' ? '已读信息和完成的待办会出现在这里。' : '可以放心去做当下的事。'}</p>
              </div>
            )}
            {visibleItems.map((item) => (
              <article className={`todo-item ${item.status === 'completed' ? 'is-completed' : item.status === 'dismissed' ? 'is-dismissed' : ''}`} key={item.id}>
                <button className="todo-check" aria-label={item.status === 'completed' ? '重新打开' : item.insight?.kind === 'information' ? '标记已读' : '标记完成'} disabled={item.status === 'dismissed'} onClick={() => void setStatus(item, item.status === 'completed' ? 'pending' : 'completed')}>
                  {item.status === 'completed' && <Check width={17} height={17} />}
                </button>
                <div className="todo-item-main">
                  <div className="todo-item-title-row">
                    <h3>{item.title}</h3>
                    <span className={`todo-priority todo-priority--${item.priority}`}>{priorityLabel[item.priority]}</span>
                  </div>
                  {item.details && <p>{item.details}</p>}
                  {item.insight && (
                    <div className="todo-insight">
                      <div className="todo-insight-heading">
                        <strong>{item.insight.kind === 'information' ? '有用信息' : '行动事项'} · 重要度 {item.insight.score}/100</strong>
                        {item.insight.adjustment !== 0 && <small>反馈调整 {item.insight.adjustment > 0 ? '+' : ''}{item.insight.adjustment}</small>}
                      </div>
                      <p>{item.insight.reason}</p>
                      {item.insight.topics.length > 0 && <div className="todo-learned-topics">{item.insight.topics.map((topic) => <span key={topic}>{topic}</span>)}</div>}
                    </div>
                  )}
                  {item.evidence && <div className="todo-evidence">
                    <div className="todo-evidence-heading"><strong>{item.evidence.engine === 'laya' ? 'Laya 初步分类' : item.evidence.engine === 'jev' ? 'Jev 判断依据' : '提取依据'}</strong>{item.evidence.needsReview && <span className="todo-evidence-review">需要核对</span>}{typeof item.evidence.decisionConfidence === 'number' && <span title="判断服务报告的置信度，不代表经过验证的准确率">判断置信度 {Math.round(item.evidence.decisionConfidence * 100)}%</span>}</div>
                    <p>{evidenceDateLabel(item)}</p>
                    {item.evidence.dateQuote && <p>原文时间：{item.evidence.dateQuote}</p>}
                    {item.evidence.dateStatus === 'exact' && item.evidence.timeZone && <p>原文时间按 {item.evidence.timeZone} 解析，显示为本机时间。</p>}
                    {item.evidence.messageQuote && <blockquote aria-label="原文证据">{item.evidence.messageQuote}</blockquote>}
                  </div>}
                  <div className="todo-item-meta">
                    {(item.insight?.kind !== 'information' || item.dueAt) && <span><Clock width={14} height={14} /> {formatSchedule(item)}</span>}
                    <span className={`todo-source todo-source--${item.sourceType}`}>{sourceName(item)}</span>
                    <span className="todo-source-label">{item.sourceLabel}</span>
                    {item.sourceType !== 'manual' && !item.evidence && <span title="模型自报的置信度，不代表真实准确率">{Math.round(item.confidence * 100)}% 置信</span>}
                    {item.status !== 'pending' && <span className="todo-item-status">{item.status === 'dismissed' ? '已忽略' : item.insight?.kind === 'information' ? '已读' : '已完成'}</span>}
                    {item.status === 'pending' && item.dueAt && (
                      <button className="todo-item-calendar" onClick={() => void addToCalendar(item)}>
                        <Calendar width={13} height={13} /> 加入日历
                      </button>
                    )}
                  </div>
                  {item.status === 'pending' && item.dueAt && <p className="todo-reminder-status">
                    {state.settings.reminderEnabled
                      ? `系统提醒：${reminderTimeLabel(item, state.settings.remindBeforeMinutes)}（${formatReminder(state.settings.remindBeforeMinutes)}）`
                      : '系统提醒当前关闭，可在自动化中开启；也可以加入日历。'}
                  </p>}
                  {item.status === 'pending' && <div className="todo-date-action">
                    {dueEditor?.id === item.id ? (
                      <form className="todo-date-editor" onSubmit={(event) => { event.preventDefault(); void saveReminderTime(item) }}>
                        <label htmlFor={`todo-date-${item.id}`}>由你确认的日期和时间</label>
                        <input id={`todo-date-${item.id}`} type="datetime-local" required value={dueEditor.value} disabled={dueSaving} onChange={(event) => setDueEditor({ id: item.id, value: event.target.value })} />
                        <small>按本机时区（{Intl.DateTimeFormat().resolvedOptions().timeZone}）设置事项时间，不改动原消息证据。{state.settings.reminderEnabled ? `系统提醒：${formatReminder(state.settings.remindBeforeMinutes)}。` : '系统提醒当前关闭，可在自动化中开启。'}{item.evidence?.dateStatus === 'date-only' && item.evidence.date ? `原文日期为 ${item.evidence.date}，请补充你确认的具体时间。` : ''}</small>
                        <div><button type="submit" disabled={dueSaving}>{dueSaving ? '正在保存…' : '确认时间'}</button><button type="button" disabled={dueSaving} onClick={() => setDueEditor(null)}>取消</button>{item.dueAt && <button type="button" disabled={dueSaving} onClick={() => void saveReminderTime(item, true)}>清除时间</button>}</div>
                      </form>
                    ) : <button className="todo-date-open" disabled={dueSaving} onClick={() => setDueEditor({ id: item.id, value: localDateInput(item.dueAt) })}>{item.dueAt ? '修改提醒时间' : '设置提醒时间'}</button>}
                  </div>}
                  {item.sourceType !== 'manual' && (
                    <div className="todo-feedback" aria-label="消息价值反馈" aria-busy={feedbackSavingId === item.id}>
                      <button aria-pressed={item.feedback === 'useful'} disabled={Boolean(feedbackSavingId)} onClick={() => void markFeedback(item, 'useful')}>特别有用</button>
                      <button aria-pressed={item.feedback === 'not-useful'} disabled={Boolean(feedbackSavingId)} onClick={() => void markFeedback(item, 'useless')}>对我没用</button>
                      {item.feedback && <button className="todo-feedback-undo" disabled={Boolean(feedbackSavingId)} onClick={() => void markFeedback(item, null)}>撤销反馈</button>}
                    </div>
                  )}
                  {item.sourcePreview && <details><summary>查看原消息</summary><blockquote>{item.sourcePreview}</blockquote></details>}
                </div>
                <button className="todo-delete" aria-label="删除" onClick={() => void remove(item)}><TrashBin width={16} height={16} /></button>
              </article>
            ))}
          </div>
        </section>

        <aside className="todo-side">
          <section className="todo-panel">
            <div className="todo-panel-header todo-panel-header--compact">
              <div><span className="todo-section-kicker">INBOXES</span><h2>信息来源</h2></div>
              <button className="todo-connect-mail" onClick={() => setShowMailSetup((value) => !value)}><Plus width={13} height={13} /> 连接邮箱</button>
            </div>
            {showMailSetup && (
              <div className="todo-mail-setup">
                <select value={mailProvider} onChange={(event) => {
                  const provider = event.target.value as TodoMailProvider
                  setMailProvider(provider)
                  if (provider !== 'custom') {
                    setMailPort(mailPresets[provider].port)
                    setMailSecure(mailPresets[provider].secure)
                  }
                }}>
                  <option value="gmail">Gmail（推荐：应用专用密码）</option>
                  <option value="outlook">Outlook / Microsoft 365</option>
                  <option value="icloud">iCloud 邮箱</option>
                  <option value="yahoo">Yahoo 邮箱</option>
                  <option value="qq">QQ 邮箱</option>
                  <option value="163">163 邮箱</option>
                  <option value="custom">自定义 IMAP</option>
                </select>
                {getTodoMailGuide(mailProvider) && (
                  <ol className="todo-mail-steps">
                    {getTodoMailGuide(mailProvider)!.steps.map((step, index) => (
                      <li key={step}><span>{index + 1}</span>{step}</li>
                    ))}
                  </ol>
                )}
                <input type="email" value={mailEmail} onChange={(event) => setMailEmail(event.target.value)} placeholder="邮箱地址，如 you@gmail.com" />
                {mailProvider === 'custom' && (
                  <div className="todo-mail-custom-row">
                    <input value={mailHost} onChange={(event) => setMailHost(event.target.value)} placeholder="IMAP 服务器，如 imap.example.com" />
                    <input type="number" min="1" max="65535" value={mailPort} onChange={(event) => setMailPort(Number(event.target.value) || 0)} aria-label="IMAP 端口" />
                    <select value={mailSecure ? 'tls' : 'starttls'} onChange={(event) => setMailSecure(event.target.value === 'tls')} aria-label="IMAP 加密方式">
                      <option value="tls">SSL/TLS</option>
                      <option value="starttls">STARTTLS</option>
                    </select>
                  </div>
                )}
                <input type="password" value={mailPassword} onChange={(event) => setMailPassword(event.target.value)} placeholder={getTodoMailGuide(mailProvider)?.passwordLabel || '应用专用密码 / 授权码'} />
                <p>不用登录网页邮箱。按上面 3 步生成应用专用密码，填到这里验证即可。不要填平时登录邮箱的密码。连上后点「扫描今日消息」，今天的邮件会一起分析。</p>
                {mailProvider !== 'custom' && <button className="todo-provider-help" onClick={() => void openWebmail(mailPresets[mailProvider].help, `${mailPresets[mailProvider].name} · 应用密码帮助`)}>第 2 步：打开官方页面生成密码 ↗</button>}
                <button onClick={() => void connectMail()} disabled={mailConnecting}>{mailConnecting ? '正在验证…' : '第 3 步：验证并开始分析邮件'}</button>
              </div>
            )}
            {showGoogleSetup && (
              <div className="todo-mail-setup todo-google-setup">
                <div className="todo-google-setup-heading">
                  <strong>Google 只读授权</strong>
                  <span>一次连接 Gmail + Drive</span>
                </div>
                <p>在 Google Cloud 启用 Gmail API 与 Drive API，创建“桌面应用”OAuth 客户端；复制客户端 ID 和可选密钥后，登录会在系统浏览器中完成。</p>
                <button className="todo-google-console" onClick={() => void openWebmail('https://console.cloud.google.com/auth/clients', 'Google Cloud OAuth')}>打开 Google Cloud 配置页 ↗</button>
                <input value={googleClientId} onChange={(event) => setGoogleClientId(event.target.value)} placeholder="客户端 ID · ….apps.googleusercontent.com" />
                <input type="password" value={googleClientSecret} onChange={(event) => setGoogleClientSecret(event.target.value)} placeholder="客户端密钥（桌面客户端如有则填写）" />
                <p>仅申请 Gmail 只读、Drive 只读与邮箱身份；不会发信、删信、改已读或改动云盘文件。令牌由系统钥匙串加密。</p>
                <button onClick={() => void connectGoogle()} disabled={googleConnecting}>{googleConnecting ? '等待浏览器授权…' : '在浏览器中安全连接'}</button>
              </div>
            )}
            <div className="todo-sources">
              <div className={`todo-source-card ${state.settings.connectors.find((connector) => connector.type === 'wechat')?.enabled === false ? 'is-paused' : ''}`}>
                <span className="todo-source-logo todo-source-logo--wechat">微</span>
                <div><strong>微信本地消息</strong><p>{state.settings.connectors.find((connector) => connector.type === 'wechat')?.enabled === false ? '已暂停；邮箱仍可独立扫描' : '仅读取今日增量'}</p></div>
                <label className="todo-source-switch">
                  <input type="checkbox" checked={state.settings.connectors.find((connector) => connector.type === 'wechat')?.enabled !== false} onChange={(event) => void updateSourceEnabled('wechat', event.target.checked)} />
                  <span>扫描</span>
                </label>
              </div>
              <button className="todo-wechat-setup" onClick={() => navigate('/connect?mode=add-account')}>连接或切换微信数据 →</button>
              {state.mailAccounts.map((account) => (
                <div className="todo-source-card todo-source-card--account" key={account.id}>
                  <span className="todo-source-logo todo-source-logo--mail"><Envelope /></span>
                  <div><strong>{account.name}</strong><p>{account.error ? `同步异常：${account.error}` : account.lastSyncAt ? `上次同步 ${new Date(account.lastSyncAt).toLocaleString('zh-CN')}` : account.email}</p></div>
                  <div className="todo-source-actions">
                    <button onClick={() => void viewMailInbox(account.id, account.name)}>查看</button>
                    <button className="todo-remove-account" onClick={() => void removeMailAccount(account.id)}>移除</button>
                  </div>
                </div>
              ))}
              <div className={`todo-source-card ${state.google.connected ? 'todo-source-card--account' : ''}`}>
                <span className="todo-source-logo todo-source-logo--gmail"><Envelope /></span>
                <div><strong>Gmail 只读</strong><p>{state.google.connected ? (state.google.lastError ? `同步异常：${state.google.lastError}` : state.google.email) : 'OAuth 读取今日邮件，不改变已读状态'}</p></div>
                <div className="todo-source-actions">
                  {state.google.connected ? (
                    <>
                      <button onClick={() => void viewMailInbox('google-oauth', state.google.email || 'Gmail')}>收件箱</button>
                      <button onClick={() => void openWebmail('https://mail.google.com/', 'Gmail')}>网页</button>
                    </>
                  ) : <button onClick={() => setShowGoogleSetup((value) => !value)}>连接</button>}
                </div>
              </div>
              <div className="todo-source-card">
                <span className="todo-source-logo todo-source-logo--mail"><Envelope /></span>
                <div><strong>其他邮箱</strong><p>Outlook、QQ、163：按上方 3 步教程连接</p></div>
                <button onClick={() => setShowMailSetup(true)}>按教程连接</button>
              </div>
              <div className={`todo-source-card ${state.google.connected ? 'todo-source-card--account' : ''}`}>
                <span className="todo-source-logo todo-source-logo--drive"><Link /></span>
                <div><strong>Google Drive 链接</strong><p>{state.google.connected ? '读取链接文件名称与可导出的文本' : '连接 Google 后自动理解消息中的链接'}</p></div>
                <div className="todo-source-actions">
                  <button onClick={() => void openWebmail('https://drive.google.com/', 'Google Drive')}>打开</button>
                  {state.google.connected && <button className="todo-remove-account" onClick={() => void disconnectGoogle()}>断开</button>}
                </div>
              </div>
            </div>
            <p className="todo-source-note">应用内收件箱只渲染纯文本，不加载邮件里的远程图片或脚本。Google OAuth 与 IMAP 扫描均只读取当日增量；Drive 只处理消息里出现的链接，不遍历整个云盘。
            </p>
          </section>

          <section className="todo-panel">
            <div className="todo-panel-header todo-panel-header--compact">
              <div><span className="todo-section-kicker">RHYTHM</span><h2>自动化</h2></div>
            </div>
            <div className="todo-automation-list">
              <label>
                <span className="todo-automation-icon"><MagicWand /></span>
                <span><strong>持续增量分析</strong><small>首次 {formatHour(state.settings.scanHour)}；之后每小时运行，失败 15 分钟重试</small></span>
                <input type="checkbox" checked={state.settings.autoScanEnabled} onChange={(event) => void updateSettings({ autoScanEnabled: event.target.checked })} />
                <i />
              </label>
              <label>
                <span className="todo-automation-icon"><Bell /></span>
                <span><strong>系统提醒</strong><small>{formatReminder(state.settings.remindBeforeMinutes)}</small></span>
                <input type="checkbox" checked={state.settings.reminderEnabled} onChange={(event) => void updateSettings({ reminderEnabled: event.target.checked })} />
                <i />
              </label>
              <label>
                <span className="todo-automation-icon"><Picture /></span>
                <span><strong>每日待办壁纸</strong><small>无待办时生成风景海报</small></span>
                <input type="checkbox" checked={state.settings.wallpaperEnabled} onChange={(event) => void updateSettings({ wallpaperEnabled: event.target.checked })} />
                <i />
              </label>
            </div>
            <div className="todo-schedule-settings">
              <label>
                <span>每日扫描时间</span>
                <select value={state.settings.scanHour} onChange={(event) => void updateSettings({ scanHour: Number(event.target.value) })}>
                  {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{formatHour(hour)}</option>)}
                </select>
              </label>
              <label>
                <span>提醒提前量</span>
                <select value={state.settings.remindBeforeMinutes} onChange={(event) => void updateSettings({ remindBeforeMinutes: Number(event.target.value) })}>
                  {Array.from(new Set([state.settings.remindBeforeMinutes, 0, 5, 10, 15, 30, 60, 120, 360, 720, 1440, 2880])).sort((a, b) => a - b).map((minutes) => (
                    <option key={minutes} value={minutes}>{formatReminder(minutes)}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="todo-quick-actions">
              <button onClick={() => void exportCalendar()}><Calendar width={17} height={17} /> 导出日历</button>
              <button onClick={() => void applyWallpaper()}><Picture width={17} height={17} /> 立即更换壁纸</button>
            </div>
          </section>

          <section className="todo-panel todo-sync-panel">
            <div className="todo-panel-header todo-panel-header--compact">
              <div><span className="todo-section-kicker">EVERYWHERE</span><h2>跨设备加密同步</h2></div>
              <span className={`todo-sync-status ${state.sync.configured && !state.sync.lastError ? 'is-ready' : ''}`}>
                {state.sync.configured && !state.sync.lastError ? <CloudCheck /> : <Cloud />}
                {state.sync.configured ? (state.sync.lastError ? '需检查' : '已连接') : '未设置'}
              </span>
            </div>

            {state.sync.configured && !showSyncSetup ? (
              <div className="todo-sync-summary">
                <div className="todo-sync-server">
                  <span><ShieldKeyhole /></span>
                  <div><strong>端到端加密 WebDAV</strong><p>{state.sync.username} · {state.sync.endpoint}</p></div>
                </div>
                <p className={state.sync.lastError ? 'is-error' : ''}>
                  {state.sync.lastError || (state.sync.lastSyncAt
                    ? `上次同步 ${new Date(state.sync.lastSyncAt).toLocaleString('zh-CN')}`
                    : '已保存配置，尚未完成首次同步')}
                </p>
                <div className="todo-sync-actions">
                  <button className="is-primary" onClick={() => void syncNow()} disabled={syncing}>{syncing ? '同步中…' : '立即同步'}</button>
                  <button onClick={() => setShowSyncSetup(true)}>修改</button>
                  <button className="is-danger" onClick={() => void disconnectSync()}>断开</button>
                </div>
              </div>
            ) : (
              <div className="todo-sync-form">
                <p>可使用坚果云、Nextcloud、群晖等 WebDAV。服务器看到的只有 AES‑256‑GCM 密文。</p>
                <input value={syncEndpoint} onChange={(event) => setSyncEndpoint(event.target.value)} placeholder="https://dav.example.com/dav/" />
                <input value={syncUsername} onChange={(event) => setSyncUsername(event.target.value)} placeholder="WebDAV 用户名" />
                <input type="password" value={syncPassword} onChange={(event) => setSyncPassword(event.target.value)} placeholder={state.sync.configured ? '密码（留空则不修改）' : '密码 / 应用专用密码'} />
                <input value={syncRemotePath} onChange={(event) => setSyncRemotePath(event.target.value)} placeholder="CipherTalk/todos.enc.json" />
                <input type="password" value={syncSecret} onChange={(event) => setSyncSecret(event.target.value)} placeholder={state.sync.configured ? '恢复密钥（留空则不修改）' : '已有恢复密钥；留空则自动生成'} />
                <label><input type="checkbox" checked={syncAuto} onChange={(event) => setSyncAuto(event.target.checked)} /> 自动同步任务变化</label>
                <label><input type="checkbox" checked={syncSourcePreview} onChange={(event) => setSyncSourcePreview(event.target.checked)} /> 同步原消息与证据摘录（默认关闭；事项标题仍会加密同步）</label>
                <div className="todo-sync-actions">
                  <button className="is-primary" onClick={() => void configureSync()} disabled={syncing}>{syncing ? '正在验证并同步…' : '保存、验证并同步'}</button>
                  {state.sync.configured && <button onClick={() => setShowSyncSetup(false)}>取消</button>}
                </div>
              </div>
            )}

            {generatedSecret && (
              <div className="todo-recovery-key">
                <strong>只显示这一次：同步恢复密钥</strong>
                <code>{generatedSecret}</code>
                <p>手机端连接同一 WebDAV 时需要它。本应用无法替你找回，请保存到密码管理器。</p>
                <button onClick={() => void copyGeneratedSecret()}>复制恢复密钥</button>
              </div>
            )}
          </section>

          <section className="todo-privacy-card">
            <span>本地优先</span>
            <h3>你的数据，你来决定去向。</h3>
            <p>消息指纹、待办和扫描状态保存在本机；只有待判断的文本片段会发给你配置的 API 服务商。</p>
          </section>
        </aside>
      </main>

      {mailInboxOpen && (
        <div className="todo-mail-viewer" role="dialog" aria-modal="true" aria-label={`${mailInboxLabel}收件箱`}>
          <button className="todo-mail-viewer-backdrop" aria-label="关闭收件箱" onClick={() => setMailInboxOpen(false)} />
          <section className="todo-mail-viewer-window">
            <header>
              <div>
                <span className="todo-section-kicker">READ ONLY INBOX</span>
                <h2>{mailInboxLabel}</h2>
                <p>最近 {mailInboxMessages.length} 封 · 纯文本安全预览</p>
              </div>
              <button className="todo-mail-viewer-close" aria-label="关闭" onClick={() => setMailInboxOpen(false)}>×</button>
            </header>
            {mailInboxLoading ? (
              <div className="todo-mail-viewer-loading"><span /><p>正在只读加载收件箱…</p></div>
            ) : mailInboxMessages.length === 0 ? (
              <div className="todo-mail-viewer-empty"><Envelope /><strong>收件箱暂时为空</strong><p>这里不会改变邮件的已读状态。</p></div>
            ) : (
              <div className="todo-mail-viewer-layout">
                <nav aria-label="邮件列表">
                  {mailInboxMessages.map((message) => (
                    <button key={`${message.accountId}:${message.id}`} className={selectedMail?.id === message.id ? 'is-active' : ''} onClick={() => setSelectedMailId(message.id)}>
                      <span>{message.from || '未知发件人'}<time>{new Date(message.receivedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</time></span>
                      <strong>{message.subject || '无主题'}</strong>
                      <p>{message.snippet || '无纯文本内容'}</p>
                    </button>
                  ))}
                </nav>
                {selectedMail && (
                  <article>
                    <div className="todo-mail-viewer-subject">
                      <span>{selectedMail.hasAttachments ? '含附件 · 附件不会自动下载' : '纯文本邮件'}</span>
                      <h3>{selectedMail.subject || '无主题'}</h3>
                      <dl>
                        <div><dt>发件人</dt><dd>{selectedMail.from || '未知'}</dd></div>
                        <div><dt>收件人</dt><dd>{selectedMail.to || '未知'}</dd></div>
                        <div><dt>时间</dt><dd>{new Date(selectedMail.receivedAt).toLocaleString('zh-CN')}</dd></div>
                      </dl>
                    </div>
                    <pre>{selectedMail.body || '这封邮件没有可显示的纯文本正文。'}</pre>
                  </article>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

export default TodoPage
