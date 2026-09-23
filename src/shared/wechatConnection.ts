export type WechatPreflightCheck = {
  id: 'platform' | 'security' | 'component' | 'process' | 'database'
  label: string
  status: 'pass' | 'warning' | 'blocked'
  detail: string
}

export type WechatPreflightReport = {
  platform: string
  supported: boolean
  canAutoGet: boolean
  checks: WechatPreflightCheck[]
  recommendation: 'automatic' | 'manual'
  summary: string
}

export const MAC_WECHAT_SECURITY_MESSAGE = '当前 Mac 的系统保护限制自动读取微信密钥。你可以手动填入已有密钥，或先使用邮箱等信息来源；无需为了使用本应用更改系统安全设置。'

/** Only evaluates observations: this must never start WeChat or change system settings. */
export function buildWechatPreflight(input: {
  platform: string
  arch: string
  running: boolean
  componentReady: boolean
  componentError?: string
  security?: 'enabled' | 'disabled' | 'unknown'
  database?: 'ready' | 'missing' | 'unreadable'
}): WechatPreflightReport {
  const supported = (input.platform === 'win32' && input.arch === 'x64') ||
    (input.platform === 'darwin' && ['arm64', 'x64'].includes(input.arch))
  const checks: WechatPreflightCheck[] = [{
    id: 'platform', label: '运行平台', status: supported ? 'pass' : 'blocked',
    detail: supported
      ? `${input.platform === 'darwin' ? 'macOS' : 'Windows'} · ${input.arch}`
      : '当前平台不支持自动获取。可在支持的电脑上连接微信，再通过手机伴侣查看信息。',
  }]
  if (supported) {
    if (input.platform === 'darwin') {
      checks.push({
        id: 'security', label: '系统读取权限',
        status: input.security === 'disabled' ? 'pass' : 'blocked',
        detail: input.security === 'disabled'
          ? '系统保护未阻止检查；实际读取仍可能需要你授权。'
          : input.security === 'enabled'
            ? MAC_WECHAT_SECURITY_MESSAGE
            : '无法确认系统保护状态，已暂停自动获取。可重试检查或手动填写已有密钥。',
      })
    }
    checks.push({
      id: 'component', label: '本机读取组件',
      status: input.componentReady ? 'pass' : 'blocked',
      detail: input.componentReady ? (input.platform === 'darwin' ? '登录捕获组件已就绪，开始获取时会请求系统授权。' : '已找到读取组件，获取时会进一步检查能否加载。')
        : input.componentError || '读取组件缺失。请安装适合当前系统的完整版本后重试。',
    }, {
      id: 'process', label: '微信运行状态', status: input.running ? 'pass' : 'blocked',
      detail: input.platform === 'darwin'
        ? (input.running ? '已检测到微信。获取前请退出账号，停留登录界面，等监听就绪后再登录。' : '请打开电脑版微信并停留登录界面，再点击重新检查。')
        : input.running ? '已检测到微信。请确保已登录，并打开任意聊天。'
          : '请先手动打开电脑版微信并登录，再点击重新检查。自动获取不会强制关闭微信。',
    }, {
      id: 'database', label: '数据库目录',
      status: input.database === 'ready' ? 'pass' : input.database === 'unreadable' || input.platform === 'darwin' ? 'blocked' : 'warning',
      detail: input.database === 'ready' ? '目录可读取，获取后会验证密钥。'
        : input.database === 'unreadable' ? '所选目录不存在或不可读取，请重新选择微信数据目录。'
          : '尚未选择数据目录。选择后可自动验证密钥是否属于当前账号。',
    })
  }
  const blocker = checks.find(check => check.status === 'blocked')
  const canAutoGet = supported && !blocker
  return {
    platform: input.platform, supported, canAutoGet, checks,
    recommendation: canAutoGet ? 'automatic' : 'manual',
    summary: blocker?.detail || (input.platform === 'darwin' ? '可以开始登录时获取。先停留在微信登录页，等待监听就绪后再登录。' : '可以尝试自动获取。微信版本与实际读取权限仍会影响结果。'),
  }
}

/** Native errors can include raw helper output, including the database key. */
export function redactWechatKey(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value ?? '')
  return text.replace(/[0-9a-f]{64,}/gi, '[密钥已隐藏]')
}

export function isWechatDatabaseKey(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value.trim())
}

export function parseMacSipStatus(output: string): 'enabled' | 'disabled' | 'unknown' {
  const match = output.match(/System Integrity Protection status:\s*(enabled|disabled)\b/i)
  return match ? match[1].toLowerCase() as 'enabled' | 'disabled' : 'unknown'
}
