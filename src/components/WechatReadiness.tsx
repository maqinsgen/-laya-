import { useCallback, useEffect, useRef, useState } from 'react'
import type { WechatPreflightReport } from '../shared/wechatConnection'
import './WechatReadiness.css'

export function useWechatReadiness(dbPath: string, enabled = true) {
  const [report, setReport] = useState<WechatPreflightReport | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const sequence = useRef(0)
  const refresh = useCallback(async () => {
    const request = ++sequence.current
    setChecking(true)
    setError('')
    try {
      const next = await window.electronAPI.wxKey.preflight(dbPath || undefined)
      if (request === sequence.current) setReport(next)
      return next
    } catch {
      if (request === sequence.current) { setReport(null); setError('环境检查未完成，请重试；也可以使用已有密钥。') }
      return null
    } finally { if (request === sequence.current) setChecking(false) }
  }, [dbPath])
  useEffect(() => {
    setReport(null)
    if (enabled) void refresh()
    return () => { sequence.current++ }
  }, [enabled, refresh])
  return { report, checking, error, refresh }
}

export function WechatReadiness({ report, checking, error, onRefresh }: {
  report: WechatPreflightReport | null
  checking: boolean
  error: string
  onRefresh: () => void
}) {
  return <section className="wechat-readiness" aria-label="微信连接环境检查" aria-busy={checking}>
    <div className="wechat-readiness-heading"><div><span>CONNECTION CHECK</span><h3>先检查，再连接</h3></div><button type="button" disabled={checking} onClick={onRefresh}>{checking ? '检查中…' : '重新检查'}</button></div>
    <p role="status">{checking ? '正在检查平台、连接组件和微信状态…' : error || report?.summary || '检查环境后选择连接方式。'}</p>
    {!checking && report && <ul>{report.checks.map((check) => <li key={check.id} data-status={check.status}><span className="wechat-check-mark" aria-hidden="true">{check.status === 'pass' ? '✓' : check.status === 'blocked' ? '!' : '·'}</span><div><strong>{check.label}</strong><p>{check.detail}</p></div></li>)}</ul>}
    <small>检查不会获取密钥、重启微信或修改系统安全设置。</small>
  </section>
}
