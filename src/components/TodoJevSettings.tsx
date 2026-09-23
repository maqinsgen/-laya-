import { useEffect, useState } from 'react'
import { todoPlatform } from '../services/todoPlatform'
import {
  DEFAULT_JEV_ENDPOINT, DEFAULT_JEV_MODEL, DEFAULT_LAYA_ENDPOINT, DEFAULT_LAYA_MODEL,
  isLocalTodoDecisionEndpoint, todoDecisionRequiresApiKey,
  type TodoJevBackend, type TodoJevConfigInput, type TodoJevConfigState,
} from '../shared/todoJevConfig'
import './TodoJevSettings.css'

interface Props {
  disabled?: boolean
  onStateChange: (state: TodoJevConfigState) => void
  onSaved: () => Promise<void>
}

export default function TodoJevSettings({ disabled = false, onStateChange, onSaved }: Props) {
  const [saved, setSaved] = useState<TodoJevConfigState | null>(null)
  const [draft, setDraft] = useState<TodoJevConfigInput>({ enabled: false, backend: 'laya', endpoint: DEFAULT_LAYA_ENDPOINT, model: DEFAULT_LAYA_MODEL })
  const [apiKey, setApiKey] = useState('')
  const [clearApiKey, setClearApiKey] = useState(false)
  const [busy, setBusy] = useState<'load' | 'save' | 'test' | null>('load')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const backend = draft.backend ?? 'laya'
  const local = isLocalTodoDecisionEndpoint(draft.endpoint)
  const requiresApiKey = todoDecisionRequiresApiKey(backend, draft.endpoint)

  const load = async () => {
    setBusy('load')
    setError('')
    try {
      const next = await todoPlatform.getJevConfig()
      setSaved(next)
      setDraft({ enabled: next.enabled, backend: next.backend, endpoint: next.endpoint, model: next.model })
      onStateChange(next)
    } catch { setError('无法读取判断模型配置，请重试或重新打开应用。') }
    finally { setBusy(null) }
  }
  useEffect(() => { void load() }, [])

  const input = (): TodoJevConfigInput => ({ ...draft, apiKey: apiKey || undefined, clearApiKey })
  const updateDraft = (patch: Partial<TodoJevConfigInput>) => {
    setDraft((current) => ({ ...current, ...patch }))
    setMessage('')
    setError('')
  }
  const selectBackend = (next: TodoJevBackend) => {
    setDraft({ enabled: false, backend: next, endpoint: next === 'laya' ? DEFAULT_LAYA_ENDPOINT : DEFAULT_JEV_ENDPOINT, model: next === 'laya' ? DEFAULT_LAYA_MODEL : DEFAULT_JEV_MODEL })
    setApiKey('')
    setClearApiKey(Boolean(saved?.hasApiKey))
    setMessage('')
    setError('')
  }
  const save = async () => {
    if (busy || disabled) return
    setBusy('save')
    setError('')
    setMessage('')
    try {
      const result = await todoPlatform.configureJev(input())
      if (!result.success || !result.state) { setError(result.error || '保存失败，请检查配置。'); return }
      setSaved(result.state)
      setDraft({ enabled: result.state.enabled, backend: result.state.backend, endpoint: result.state.endpoint, model: result.state.model })
      setApiKey('')
      setClearApiKey(false)
      onStateChange(result.state)
      setMessage(result.state.enabled ? `已启用 ${result.state.backend === 'laya' ? 'Laya' : 'Jev'}。下一次扫描使用独立判断接口，旧事项保持不变。` : '已保存，判断模式保持关闭。扫描使用原有 AI 分析模式。')
      await onSaved().catch(() => undefined)
    } catch { setError('保存失败，请稍后重试。') }
    finally { setBusy(null) }
  }
  const test = async () => {
    if (busy || disabled) return
    setBusy('test')
    setError('')
    setMessage('')
    try {
      const result = await todoPlatform.testJev(input())
      if (!result.success) { setError(result.error || '测试未通过，请检查配置。'); return }
      setMessage('固定虚构样本测试通过。测试没有保存设置，也没有读取你的消息；连通不代表分类已经过准确率验证。')
    } catch { setError('测试未完成，请检查配置或稍后重试。') }
    finally { setBusy(null) }
  }
  const destinationChanged = Boolean(saved?.hasApiKey && (backend !== saved.backend || draft.endpoint.trim().replace(/\/$/, '') !== saved.endpoint))

  return (
    <details className="todo-jev-settings">
      <summary><span><strong>本地判断模型</strong><small>Laya 本机判断 · Jev 可选</small></span><span className={`todo-jev-badge ${saved?.enabled ? 'is-enabled' : ''}`}>{saved?.enabled ? `${saved.backend === 'laya' ? 'Laya' : 'Jev'} 已启用` : '默认关闭'}</span></summary>
      <div className="todo-jev-content">
        <label className="todo-jev-backend" htmlFor="todo-judgment-backend">判断方式<select id="todo-judgment-backend" disabled={Boolean(busy) || !saved || disabled} value={backend} onChange={(event) => selectBackend(event.target.value as TodoJevBackend)}><option value="laya">Laya · 本机多语言模型（实验）</option><option value="jev">Jev · 独立判断 API</option></select></label>
        <p className="todo-jev-disclosure">{local ? '当前配置仅请求下方本机地址。' : '当前为远程地址：启用并保存后，消息片段和个人关注摘要会发送给该服务。'}本模式不调用通用云端 AI，不继承其密钥，也不在本地服务失败时自动切换到云端。</p>
        {backend === 'laya' && <p className="todo-jev-help">请先启动 Laya 的 <strong>multilingual</strong> 服务，再用虚构样本测试。本机地址无需 API Key；每次只处理一条短消息，过长消息直接保留供人工核对。分类未经校准，不会自动丢弃消息，日期需你确认后才可提醒。</p>}
        <form onSubmit={(event) => { event.preventDefault(); void save() }}>
          <fieldset disabled={Boolean(busy) || !saved || disabled}>
            <label className="todo-jev-enable"><input type="checkbox" checked={draft.enabled} onChange={(event) => updateDraft({ enabled: event.target.checked })} /><span>服务就绪后，在下一次扫描中使用 {backend === 'laya' ? 'Laya' : 'Jev'} 判断</span></label>
            <div className="todo-jev-fields">
              <label htmlFor="todo-jev-endpoint">完整判断接口地址<input id="todo-jev-endpoint" type="url" required value={draft.endpoint} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(event) => updateDraft({ endpoint: event.target.value })} placeholder={backend === 'laya' ? DEFAULT_LAYA_ENDPOINT : DEFAULT_JEV_ENDPOINT} /></label>
              <label htmlFor="todo-jev-model">模型名称<input id="todo-jev-model" required maxLength={200} readOnly={backend === 'laya'} value={draft.model} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(event) => updateDraft({ model: event.target.value })} placeholder={backend === 'laya' ? DEFAULT_LAYA_MODEL : DEFAULT_JEV_MODEL} /></label>
              <label htmlFor="todo-jev-key">{requiresApiKey ? '独立 API Key' : 'API Key（本机可留空）'} <span>{saved?.hasApiKey && !destinationChanged && !clearApiKey ? '已安全保存' : requiresApiKey ? '需要专用密钥' : '无需密钥'}</span><input id="todo-jev-key" type="password" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={clearApiKey} value={apiKey} onChange={(event) => { setApiKey(event.target.value); setError(''); setMessage('') }} placeholder={!requiresApiKey ? '本机 Laya 默认无需填写' : saved?.hasApiKey && !destinationChanged ? '同一地址留空可保留已有密钥' : '填写该服务专用密钥'} /></label>
            </div>
            <p className="todo-jev-help">{backend === 'laya' ? '仅 localhost、127.0.0.1 或 ::1 的 Laya 允许无密钥；远程地址必须使用 HTTPS 和独立密钥。multilingual 用于中文；官方 laya 别名实际选择英语模型。' : <>Jev 默认使用 Typesafe 接口。使用 OpenRouter 时填写其完整 <code>/alpha/decisions</code> 地址和对应专用 Key。</>}更换判断方式或地址不会迁移旧密钥。</p>
            {destinationChanged && <p className="todo-jev-endpoint-warning">判断方式或地址已改变。{clearApiKey ? '保存时将清除旧服务密钥。' : '请填写新服务专用密钥，或明确清除旧密钥。'}</p>}
            {saved?.hasApiKey && <label className="todo-jev-clear"><input type="checkbox" checked={clearApiKey} onChange={(event) => { setClearApiKey(event.target.checked); setApiKey(''); setMessage(''); setError(''); if (event.target.checked && requiresApiKey) updateDraft({ enabled: false }) }} />保存时清除本机保存的旧 API Key</label>}
            <div className="todo-jev-actions"><button type="submit" className="is-primary">{busy === 'save' ? '正在保存…' : '保存设置'}</button><button type="button" onClick={() => void test()} disabled={clearApiKey && requiresApiKey}>{busy === 'test' ? '正在测试…' : '用虚构样本测试'}</button><small>{local ? '只请求本机服务，不读取你的消息。' : '测试会请求指定远程服务，可能产生少量费用。'}不会保存设置或自动开始扫描。</small></div>
          </fieldset>
        </form>
        {busy === 'load' && <p role="status">正在读取本机配置…</p>}
        {error && <p className="todo-jev-message is-error" role="alert">{error}</p>}
        {message && <p className="todo-jev-message" role="status">{message}</p>}
        {!saved && !busy && <button className="todo-jev-retry" onClick={() => void load()}>重新读取配置</button>}
      </div>
    </details>
  )
}
