export type TodoApiSignupMethod = 'phone' | 'email' | 'either'

export interface TodoApiVendorGuide {
  id: string
  name: string
  official: boolean
  signupUrl: string
  docsUrl: string
  signupMethod: TodoApiSignupMethod
  signupHint: string
  riskNote?: string
}

/**
 * 对齐 cc-switch 的产品模型：官方入口优先、申请方式写清楚、第三方单独标风险。
 * 这里不代售额度，只把用户带到服务商自己的注册/控制台。
 */
export const TODO_API_VENDOR_GUIDES: TodoApiVendorGuide[] = [
  {
    id: 'aws-bedrock-mantle',
    name: 'AWS / CC-Switch 代理',
    official: true,
    signupUrl: 'https://aws.amazon.com/bedrock/',
    docsUrl: 'https://docs.aws.amazon.com/bedrock/',
    signupMethod: 'either',
    signupHint: '可从本机 CC-Switch 导入 Bedrock 密钥，默认用 google.gemma-3-12b-it 分析消息',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    official: true,
    signupUrl: 'https://platform.deepseek.com/sign_in',
    docsUrl: 'https://api-docs.deepseek.com/',
    signupMethod: 'phone',
    signupHint: '可用手机号注册，创建 API Key 后即可分析待办',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    official: true,
    signupUrl: 'https://platform.openai.com/signup',
    docsUrl: 'https://platform.openai.com/api-keys',
    signupMethod: 'email',
    signupHint: '用邮箱注册 OpenAI Platform，在 API keys 创建密钥',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    official: true,
    signupUrl: 'https://console.anthropic.com/',
    docsUrl: 'https://docs.anthropic.com/en/api/getting-started',
    signupMethod: 'email',
    signupHint: '用邮箱注册 Anthropic Console 并创建 API Key',
  },
  {
    id: 'google',
    name: 'Google Gemini',
    official: true,
    signupUrl: 'https://aistudio.google.com/apikey',
    docsUrl: 'https://ai.google.dev/gemini-api/docs',
    signupMethod: 'email',
    signupHint: '使用 Google 账号在 AI Studio 创建 API Key',
  },
  {
    id: 'moonshotai-cn',
    name: 'Kimi / Moonshot',
    official: true,
    signupUrl: 'https://platform.moonshot.cn/',
    docsUrl: 'https://platform.moonshot.cn/docs',
    signupMethod: 'phone',
    signupHint: '可用手机号注册月之暗面开放平台',
  },
  {
    id: 'alibaba-cn',
    name: '通义千问',
    official: true,
    signupUrl: 'https://dashscope.console.aliyun.com/',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/',
    signupMethod: 'either',
    signupHint: '用阿里云账号（手机号或邮箱）开通百炼并创建 API Key',
  },
  {
    id: 'zhipuai',
    name: '智谱 GLM',
    official: true,
    signupUrl: 'https://open.bigmodel.cn/',
    docsUrl: 'https://docs.bigmodel.cn/',
    signupMethod: 'phone',
    signupHint: '用手机号注册智谱开放平台并创建 API Key',
  },
  {
    id: 'siliconflow-cn',
    name: 'SiliconFlow',
    official: false,
    signupUrl: 'https://cloud.siliconflow.cn/',
    docsUrl: 'https://docs.siliconflow.cn/',
    signupMethod: 'phone',
    signupHint: '第三方聚合，可用手机号注册',
    riskNote: '请求会发往第三方中转，请自行评估数据去向、SLA 与合规风险',
  },
]

const SIGNUP_METHOD_LABEL: Record<TodoApiSignupMethod, string> = {
  phone: '手机号申请',
  email: '邮箱申请',
  either: '手机号或邮箱申请',
}

export function todoApiSignupMethodLabel(method: TodoApiSignupMethod): string {
  return SIGNUP_METHOD_LABEL[method]
}

export function officialTodoApiVendorGuides(): TodoApiVendorGuide[] {
  return TODO_API_VENDOR_GUIDES.filter((item) => item.official)
}

export function resolveTodoApiVendorGuide(providerId: string): TodoApiVendorGuide | null {
  const id = String(providerId || '').trim().toLowerCase()
  return TODO_API_VENDOR_GUIDES.find((item) => item.id === id) || null
}

export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

export function resolveTodoApiSignupUrl(providerId: string, fallbackWebsite = ''): string {
  const guide = resolveTodoApiVendorGuide(providerId)
  const candidate = String(guide?.signupUrl || fallbackWebsite || '').trim()
  return isHttpsUrl(candidate) ? candidate : ''
}
