import { Button } from '@heroui/react'
import './WechatLoginCaptureGuide.css'

export function WechatLoginCaptureGuide({ busy, disabled, status, onStart, onCancel }: {
  busy: boolean
  disabled: boolean
  status: string
  onStart: () => void
  onCancel: () => void
}) {
  return <section className="wechat-login-guide" aria-label="登录时获取微信密钥">
    <div className="wechat-login-guide-title"><span>登录时获取</span><small>只在本机完成</small></div>
    <ol>
      <li><strong>停留在微信登录页</strong><span>已登录时先退出账号，暂时不要点击登录。</span></li>
      <li><strong>在这里开始获取</strong><span>完成系统授权，等待下方提示“监听已就绪”。</span></li>
      <li><strong>再登录微信</strong><span>点击微信的登录按钮，并在手机确认。程序会自动校验结果。</span></li>
    </ol>
    <div className="wechat-login-guide-actions">
      <Button type="button" variant="primary" size="sm" isDisabled={disabled || busy} onPress={onStart}>
        {busy ? '正在获取并验证…' : '已在登录界面，开始获取'}
      </Button>
      {busy && <Button type="button" variant="secondary" size="sm" onPress={onCancel}>取消获取</Button>}
    </div>
    {status && <p className="wechat-login-guide-status" role="status" aria-live="polite">{status}</p>}
    <p className="wechat-login-guide-note">已有可用连接可以继续使用，无需重复获取。失败或取消会保留原配置。</p>
  </section>
}
