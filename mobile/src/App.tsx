import { useEffect, useMemo, useRef, useState } from 'react'
import { App as NativeApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { applyTodoFeedback, compareTodoImportance } from '@shared/todoIntelligence'
import { createEmptyTodoSyncDocument } from '@shared/todoSync'
import { BRAND } from '@shared/brand'
import type { TodoFeedback, TodoItem, TodoPriority, TodoSyncDocument } from '../../src/types/todo'
import type { MobileCredentials, MobileSyncConfig } from './types'
import {
  clearMobileStorage, loadCredentials, loadLocalDocument, loadMobileConfig,
  saveMobileConnection, saveLocalDocument, saveMobileConfig,
} from './services/storage'
import { normalizeMobileEndpoint, normalizeMobileRemotePath, syncWithWebDav } from './services/webdavSync'
import { addTodoToCalendar, applyDailyWallpaper, prepareDailyWallpaper, scheduleTodoNotifications } from './services/nativeFeatures'

function dueLabel(value: string | null): string {
  if (!value) return '未设时间'
  return new Date(value).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function App() {
  const booted = useRef(false)
  const mutationBusy = useRef(false)
  const connectionBusy = useRef(false)
  const connectionEditing = useRef(false)
  const syncPromise = useRef<Promise<void> | null>(null)
  const latest = useRef<{ config: MobileSyncConfig | null; credentials: MobileCredentials | null; document: TodoSyncDocument | null }>({ config: null, credentials: null, document: null })
  const [config, setConfig] = useState<MobileSyncConfig | null>(null)
  const [credentials, setCredentials] = useState<MobileCredentials | null>(null)
  const [document, setDocument] = useState<TodoSyncDocument | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [nativeBusy, setNativeBusy] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)
  const [history, setHistory] = useState(false)
  const [notice, setNotice] = useState('')
  const [editingConnection, setEditingConnection] = useState(false)
  const [connectionError, setConnectionError] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [remotePath, setRemotePath] = useState('CipherTalk/todos.enc.json')
  const [secret, setSecret] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const [newDueAt, setNewDueAt] = useState('')
  const [newPriority, setNewPriority] = useState<TodoPriority>('medium')
  latest.current = { config, credentials, document }

  const performSync = async (currentConfig = config, currentCredentials = credentials, currentDocument = document) => {
    if (!currentConfig || !currentCredentials || !currentDocument || mutationBusy.current || connectionBusy.current || connectionEditing.current) return
    if (syncPromise.current) return syncPromise.current
    if (!navigator.onLine) {
      setNotice('当前离线，可以继续查看和编辑；联网后自动同步。')
      return
    }
    setSyncing(true)
    const operation = (async () => {
      try {
        const result = await syncWithWebDav(currentConfig, currentCredentials, currentDocument)
        await Promise.all([
          saveMobileConfig(result.config),
          saveLocalDocument(result.document, currentCredentials.secret),
        ])
        latest.current = { config: result.config, credentials: currentCredentials, document: result.document }
        setConfig(result.config)
        setDocument(result.document)
        setNotice('已与电脑同步')
        void scheduleTodoNotifications(result.document.items, result.config.remindBeforeMinutes).catch(() => 0)
        void prepareDailyWallpaper(result.document.items, result.config.wallpaperAuto).catch(() => undefined)
      } catch (error) {
        const message = errorMessage(error, '同步失败，请稍后重试')
        const failed = { ...currentConfig, lastError: message }
        await saveMobileConfig(failed).catch(() => undefined)
        latest.current.config = failed
        setConfig(failed)
        setNotice('本机内容已保留。可重试同步，或在连接设置中检查配置。')
      } finally {
        setSyncing(false)
        syncPromise.current = null
      }
    })()
    syncPromise.current = operation
    return operation
  }

  useEffect(() => {
    if (booted.current) return
    booted.current = true
    void (async () => {
      try {
        const savedConfig = await loadMobileConfig()
        const savedCredentials = await loadCredentials()
        if (savedConfig && savedCredentials) {
          const savedDocument = await loadLocalDocument(savedConfig, savedCredentials.secret)
          latest.current = { config: savedConfig, credentials: savedCredentials, document: savedDocument }
          setConfig(savedConfig)
          setCredentials(savedCredentials)
          setDocument(savedDocument)
          setLoading(false)
          await performSync(savedConfig, savedCredentials, savedDocument)
        } else {
          setLoading(false)
        }
      } catch (error) {
        setConnectionError(errorMessage(error, '读取本机数据失败，请重新连接'))
        setLoading(false)
      }
    })()
  }, [])

  useEffect(() => {
    const onOnline = () => {
      setOnline(true)
      const current = latest.current
      void performSync(current.config, current.credentials, current.document)
    }
    const onOffline = () => setOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    let disposed = false
    let listener: { remove: () => Promise<void> } | undefined
    void NativeApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) {
        setOnline(navigator.onLine)
        const current = latest.current
        void performSync(current.config, current.credentials, current.document)
      }
    }).then((handle) => {
      if (disposed) void handle.remove()
      else listener = handle
    }).catch(() => undefined)
    return () => {
      disposed = true
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      void listener?.remove()
    }
  }, [])

  const pendingCount = document?.items.filter((item) => item.status === 'pending').length ?? 0
  const activeItems = useMemo(
    () => (document?.items || []).filter((item) => history ? (item.status !== 'pending' || Boolean(item.feedback)) : item.status === 'pending').sort(compareTodoImportance),
    [document, history],
  )

  const openConnection = () => {
    if (!config || syncing || mutationBusy.current) return
    setEndpoint(config.endpoint)
    setUsername(config.username)
    setRemotePath(config.remotePath)
    setPassword('')
    setSecret('')
    setConnectionError('')
    connectionEditing.current = true
    setEditingConnection(true)
  }

  const closeConnection = () => {
    setPassword('')
    setSecret('')
    setConnectionError('')
    connectionEditing.current = false
    setEditingConnection(false)
  }

  const connect = async () => {
    if (connectionBusy.current || syncPromise.current || mutationBusy.current) return
    const nextCredentials = { password: password || credentials?.password || '', secret: secret.trim() || credentials?.secret || '' }
    if (!endpoint.trim() || !username.trim() || !nextCredentials.password || nextCredentials.secret.length < 12) {
      setConnectionError('请填写 WebDAV 地址、用户名、密码，以及电脑端显示的同步恢复密钥。')
      return
    }
    if (!navigator.onLine) {
      setConnectionError('当前没有网络，请连接网络后再验证。')
      return
    }
    connectionBusy.current = true
    setSyncing(true)
    setConnectionError('')
    try {
      const nextConfig: MobileSyncConfig = {
        endpoint: normalizeMobileEndpoint(endpoint),
        username: username.trim(),
        remotePath: normalizeMobileRemotePath(remotePath),
        deviceId: config?.deviceId ?? crypto.randomUUID(),
        lastSyncAt: config?.lastSyncAt ?? 0,
        lastError: '',
        remindBeforeMinutes: config?.remindBeforeMinutes ?? 30,
        wallpaperAuto: config?.wallpaperAuto ?? false,
      }
      // Verify the existing desktop document before saving credentials or leaving this form.
      // A mistyped path must never silently create an unrelated empty sync document.
      const local = document ?? createEmptyTodoSyncDocument(nextConfig.deviceId)
      const result = await syncWithWebDav(nextConfig, nextCredentials, local, { requireExisting: true })
      await saveMobileConnection(result.config, nextCredentials, result.document)
      latest.current = { config: result.config, credentials: nextCredentials, document: result.document }
      setConfig(result.config)
      setCredentials(nextCredentials)
      setDocument(result.document)
      closeConnection()
      setNotice('连接成功，电脑端的重要信息已同步到手机。')
      void scheduleTodoNotifications(result.document.items, result.config.remindBeforeMinutes).catch(() => 0)
    } catch (error) {
      setConnectionError(errorMessage(error, '连接失败，请检查配置后重试'))
    } finally {
      connectionBusy.current = false
      setSyncing(false)
    }
  }

  const commit = async (next: TodoSyncDocument): Promise<boolean> => {
    if (!credentials || mutationBusy.current || syncPromise.current || connectionBusy.current) return false
    mutationBusy.current = true
    setSyncing(true)
    try {
      await saveLocalDocument(next, credentials.secret)
      latest.current.document = next
      setDocument(next)
      void scheduleTodoNotifications(next.items, config?.remindBeforeMinutes ?? 30).catch(() => 0)
      mutationBusy.current = false
      await performSync(config, credentials, next)
      return true
    } catch (error) {
      setNotice(errorMessage(error, '保存失败，请重试'))
      return false
    } finally {
      mutationBusy.current = false
      setSyncing(false)
    }
  }

  const giveFeedback = async (item: TodoItem, feedback: TodoFeedback | null) => {
    if (!document) return
    const now = Date.now()
    await commit({ ...document, revision: document.revision + 1, updatedAt: now,
      items: document.items.map((candidate) => candidate.id === item.id ? applyTodoFeedback(candidate, feedback, now) : candidate),
    })
  }

  const updateStatus = async (item: TodoItem) => {
    if (!document) return
    const now = Date.now()
    await commit({ ...document, revision: document.revision + 1, updatedAt: now,
      items: document.items.map((candidate) => candidate.id === item.id
        ? { ...candidate, status: candidate.status === 'completed' ? 'pending' : 'completed', updatedAt: now }
        : candidate),
    })
  }

  const removeItem = async (item: TodoItem) => {
    if (!document || !window.confirm(`删除“${item.title}”？此操作将在联网后同步到其他设备。`)) return
    const now = Date.now()
    await commit({ ...document, revision: document.revision + 1, updatedAt: now,
      items: document.items.filter((candidate) => candidate.id !== item.id),
      tombstones: [...document.tombstones.filter((entry) => entry.id !== item.id), { id: item.id, deletedAt: now, deviceId: document.deviceId }],
    })
  }

  const addItem = async () => {
    if (!document || !newTitle.trim()) return
    const now = Date.now()
    const item: TodoItem = {
      id: crypto.randomUUID(), title: newTitle.trim(), details: '',
      dueAt: newDueAt ? new Date(newDueAt).toISOString() : null,
      priority: newPriority, status: 'pending', sourceType: 'manual', sourceLabel: '手机创建',
      sourceRef: `mobile:${now}`, sourcePreview: '', confidence: 1, createdAt: now, updatedAt: now,
    }
    if (await commit({ ...document, revision: document.revision + 1, updatedAt: now, items: [item, ...document.items] })) {
      setNewTitle('')
      setNewDueAt('')
    }
  }

  const disconnect = async () => {
    if (syncing || nativeBusy || !window.confirm('确定断开并清除本机的连接凭据、恢复密钥和缓存任务吗？未同步的修改也会移除，远端数据不会删除。')) return
    setSyncing(true)
    connectionBusy.current = true
    try {
      await clearMobileStorage()
      latest.current = { config: null, credentials: null, document: null }
      setConfig(null)
      setCredentials(null)
      setDocument(null)
      closeConnection()
      setNotice('')
    } catch (error) {
      setConnectionError(errorMessage(error, '断开失败，请重试'))
    } finally {
      connectionBusy.current = false
      setSyncing(false)
    }
  }

  const runNativeAction = async (action: () => Promise<string>) => {
    if (nativeBusy) return
    setNativeBusy(true)
    try { setNotice(await action()) } catch (error) { setNotice(errorMessage(error, '操作未完成，请重试')) }
    finally { setNativeBusy(false) }
  }

  const toggleAutoWallpaper = async (enabled: boolean) => {
    if (!config || !document) return
    await runNativeAction(async () => {
      if (enabled) await prepareDailyWallpaper(document.items, true, true)
      const next = { ...config, wallpaperAuto: enabled }
      await saveMobileConfig(next)
      latest.current.config = next
      setConfig(next)
      return enabled ? '已应用今日壁纸，并安排未来 7 天自动更新' : '已停止续订壁纸；系统中已安排的未来 7 天更新仍可能执行。'
    })
  }

  if (loading) return <main className="mobile-loading" role="status"><span /><p>正在安全地读取信息…</p></main>

  if (!config || !credentials || !document || editingConnection) {
    const isEditing = Boolean(config && credentials && document)
    return (
      <main className="mobile-onboarding">
        {isEditing && <button className="mobile-back" disabled={syncing} onClick={closeConnection}>← 返回我的信息</button>}
        <img className="mobile-mark" src="./notewake-mark.svg" alt="" width="50" height="50" />
        <span className="mobile-kicker">{BRAND.displayName} · 手机伴侣</span>
        <h1>{isEditing ? <>保持连接，<br />随时接着做。</> : <>把重要的事，<br />带在身边。</>}</h1>
        <p>{isEditing ? '修改连接后会保留本机事项，再与电脑端的同步文件合并。密码和恢复密钥留空时沿用当前设置。' : '电脑整理消息，手机查看重点、反馈和完成。只需连接一次，以后打开就能继续。'}</p>
        {!isEditing && <ol className="mobile-setup-steps"><li><span>1</span>在电脑端打开「跨设备加密同步」</li><li><span>2</span>完成一次同步，再填写以下信息</li></ol>}
        <form className="mobile-connect-card" onSubmit={(event) => { event.preventDefault(); void connect() }} aria-busy={syncing}>
          <div className="mobile-card-heading"><h2>{isEditing ? '连接设置' : '连接你的电脑'}</h2><span>端到端加密</span></div>
          <fieldset disabled={syncing}>
            <label htmlFor="endpoint">WebDAV 服务地址</label>
            <input id="endpoint" type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="url" required value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://dav.example.com/dav/" />
            <small>与电脑端填写的服务地址一致，需要 HTTPS。</small>
            <label htmlFor="username">用户名</label>
            <input id="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} placeholder="WebDAV 账号" />
            <label htmlFor="password">WebDAV 密码</label>
            <input id="password" type="password" autoComplete="current-password" required={!isEditing} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={isEditing ? '留空保留已保存的密码' : '服务商提供的密码或应用专用密码'} />
            <label htmlFor="remotePath">远端文件路径</label>
            <input id="remotePath" autoCapitalize="none" autoCorrect="off" spellCheck={false} required value={remotePath} onChange={(event) => setRemotePath(event.target.value)} placeholder="CipherTalk/todos.enc.json" />
            <small>复制电脑端的「远端路径」，包含文件名。</small>
            <label htmlFor="secret">同步恢复密钥</label>
            <input id="secret" type="password" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="off" minLength={12} required={!isEditing} value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={isEditing ? '留空保留已保存的恢复密钥' : '粘贴电脑端生成的同步恢复密钥'} />
            <small>这是跨设备同步密钥，不是微信数据库密钥。</small>
            <button type="submit" className="mobile-primary">{syncing ? '正在连接并验证密文…' : isEditing ? '验证并保存连接' : '连接并同步'}</button>
          </fieldset>
          {connectionError && <div className="mobile-notice is-error" role="alert">{connectionError}</div>}
          {!online && <p className="mobile-form-hint">当前离线，请联网后再连接。</p>}
          <p className="mobile-form-hint">{Capacitor.isNativePlatform() ? '密码和密钥保存在本机系统安全存储中。' : '当前为浏览器预览，正式使用请安装手机 App 以使用系统安全存储。'}服务器仅保存加密文档。</p>
        </form>
        <details className="mobile-help"><summary>连接不成功时，检查这里</summary><p>先确认电脑端显示同步成功，再核对服务地址、文件路径和恢复密钥。部分服务商需要单独生成应用专用密码。</p><p>手机不需要重新获取微信密钥，也不需要与电脑处于同一个 Wi-Fi；两端只需能访问同一个 WebDAV 服务。</p></details>
        {isEditing && <button className="mobile-disconnect" disabled={syncing} onClick={() => void disconnect()}>断开并清除此设备数据</button>}
      </main>
    )
  }

  const syncLabel = syncing ? '正在加密同步…' : !online ? '离线可用 · 联网后同步' : config.lastError ? '同步未完成 · 本机内容已保留' : config.lastSyncAt ? `上次同步 ${dueLabel(new Date(config.lastSyncAt).toISOString())}` : '等待首次同步'
  return (
    <main className="mobile-shell">
      <header className="mobile-header">
        <div><span className="mobile-kicker">{new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })}</span><h1>重要的事，<br />一件件来。</h1><p>{pendingCount ? `${pendingCount} 条信息，值得你关注。` : '给今天留一点从容。'}</p></div>
        <button className={config.lastError ? 'has-error' : ''} onClick={() => void performSync()} disabled={syncing || !online} aria-label={syncing ? '正在同步' : '立即同步'}><span className={syncing ? 'is-spinning' : ''}>↻</span></button>
      </header>
      <div className={`mobile-sync-pill ${config.lastError && online ? 'is-error' : !online ? 'is-offline' : ''}`} role="status"><span />{syncLabel}</div>
      {config.lastError && online && <div className="mobile-sync-recovery" role="alert"><p>{config.lastError}</p><div><button disabled={syncing} onClick={() => void performSync()}>重新同步</button><button disabled={syncing} onClick={openConnection}>检查连接设置</button></div></div>}
      {notice && <div className="mobile-notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="关闭提示">×</button></div>}

      <fieldset className="mobile-editing" disabled={syncing}>
        <form className="mobile-add" onSubmit={(event) => { event.preventDefault(); void addItem() }}>
          <label htmlFor="new-title">随手记</label>
          <input id="new-title" value={newTitle} maxLength={500} onChange={(event) => setNewTitle(event.target.value)} placeholder="记下一件不能忘的事…" />
          <div>
            <input type="datetime-local" aria-label="截止时间，可留空" value={newDueAt} onChange={(event) => setNewDueAt(event.target.value)} />
            <select aria-label="重要程度" value={newPriority} onChange={(event) => setNewPriority(event.target.value as TodoPriority)}><option value="high">高优先</option><option value="medium">中优先</option><option value="low">低优先</option></select>
            <button type="submit" disabled={!newTitle.trim()}>添加</button>
          </div>
        </form>
      </fieldset>
      <section className="mobile-tasks">
        <div className="mobile-section-title"><h2>{history ? '完成与反馈记录' : '待关注'}</h2><span>{activeItems.length}</span></div>
        <div className="mobile-view-tabs" aria-label="信息视图"><button aria-pressed={!history} onClick={() => setHistory(false)}>待关注</button><button aria-pressed={history} onClick={() => setHistory(true)}>完成与反馈</button></div>
        {!activeItems.length && <div className="mobile-empty"><span aria-hidden="true">✓</span><h3>{history ? '还没有完成或反馈记录' : '暂时没有待关注的信息'}</h3><p>{history ? '完成事项或标记消息有用后，可以在这里找回。' : '电脑整理好新消息后，会在下一次同步时出现在这里。'}</p></div>}
        {activeItems.map((item) => (
          <article className={`mobile-task priority-${item.priority} ${item.status === 'completed' ? 'is-completed' : ''}`} key={item.id}>
            <div className="mobile-task-top"><button disabled={syncing} className="mobile-check" onClick={() => void updateStatus(item)} aria-label={item.status === 'completed' ? `恢复待办：${item.title}` : `完成：${item.title}`} aria-pressed={item.status === 'completed'}>✓</button><div className="mobile-task-content"><h3>{item.title}</h3><p>{dueLabel(item.dueAt)} · {item.sourceLabel}</p></div></div>
            {item.insight && <div className="mobile-insight"><strong>{item.insight.kind === 'information' ? '有用信息' : '行动事项'}<span>{item.insight.score}<small>/100</small></span></strong><p>{item.insight.reason}</p></div>}
            {item.evidence && <div className="mobile-evidence">
              <span>{item.evidence.engine === 'laya' ? 'Laya 判断 · 实验性排序' : item.evidence.engine === 'jev' ? 'Jev 判断' : '原文核对'}{item.evidence.needsReview ? ' · 待你确认' : ''}</span>
              {item.evidence.dateStatus === 'user-confirmed' && <p>{item.dueAt ? `你设置的时间：${dueLabel(item.dueAt)}` : '你已清除提醒时间'}</p>}
              {item.evidence.date && <p>原文日期：{item.evidence.date}{item.evidence.dateStatus === 'date-only' ? ' · 未写明时刻，不设提醒' : item.evidence.dateStatus === 'unconfirmed' ? ' · 时刻待确认，不设提醒' : ''}</p>}
              {item.evidence.dateStatus === 'unconfirmed' && !item.evidence.date && <p>日期归属不明确，未设置提醒。</p>}
              {item.evidence.messageQuote && <details><summary>查看原文证据</summary><blockquote>{item.evidence.messageQuote}</blockquote></details>}
            </div>}
            <div className="mobile-task-actions">
              {item.sourceType !== 'manual' && <div className="mobile-feedback"><button disabled={syncing} aria-pressed={item.feedback === 'useful'} onClick={() => void giveFeedback(item, item.feedback === 'useful' ? null : 'useful')}>特别有用</button><button disabled={syncing} aria-pressed={item.feedback === 'not-useful'} onClick={() => void giveFeedback(item, item.feedback === 'not-useful' ? null : 'not-useful')}>对我没用</button>{item.feedback && <button disabled={syncing} className="mobile-feedback-undo" onClick={() => void giveFeedback(item, null)}>撤销</button>}</div>}
              <div className="mobile-task-utilities"><button disabled={syncing || nativeBusy} onClick={() => void runNativeAction(async () => { await addTodoToCalendar(item, config.remindBeforeMinutes); return '已返回日历，请以系统中的保存结果为准。' })}>加入日历</button><button disabled={syncing} className="mobile-remove" onClick={() => void removeItem(item)} aria-label={`删除：${item.title}`}>删除</button></div>
            </div>
          </article>
        ))}
      </section>
      <section className="mobile-tools" aria-label="手机工具">
        <button disabled={nativeBusy} onClick={() => void runNativeAction(async () => `已安排 ${await scheduleTodoNotifications(document.items, config.remindBeforeMinutes)} 个系统提醒`)}><span aria-hidden="true">◴</span><strong>截止提醒</strong><small>提前 {config.remindBeforeMinutes} 分钟</small></button>
        <button disabled={nativeBusy} onClick={() => void runNativeAction(async () => (await applyDailyWallpaper(document.items)) === 'applied' ? '今日壁纸已应用' : '请从分享面板保存并设置壁纸')}><span aria-hidden="true">◫</span><strong>今日壁纸</strong><small>{Capacitor.getPlatform() === 'android' ? '一键应用到桌面' : '生成并保存到手机'}</small></button>
      </section>
      {Capacitor.getPlatform() === 'android' && <label className="mobile-wallpaper-toggle"><input type="checkbox" disabled={nativeBusy || syncing} checked={config.wallpaperAuto} onChange={(event) => void toggleAutoWallpaper(event.target.checked)} /><span><strong>每天自动更新壁纸</strong><small>每次打开应用时续订未来 7 天的壁纸</small></span></label>}
      <footer><p>端到端加密同步事项与反馈<br />原文证据默认不单独同步</p><button disabled={syncing || nativeBusy} onClick={openConnection}>连接设置</button></footer>
    </main>
  )
}

export default App
