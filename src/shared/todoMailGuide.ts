import type { TodoMailProvider } from '../types/todo'

export interface TodoMailGuide {
  provider: TodoMailProvider
  name: string
  recommended?: boolean
  passwordLabel: string
  helpUrl: string
  webUrl: string
  steps: string[]
}

const GUIDES: Record<Exclude<TodoMailProvider, 'custom'>, TodoMailGuide> = {
  gmail: {
    provider: 'gmail',
    name: 'Gmail',
    recommended: true,
    passwordLabel: '16 位应用专用密码',
    helpUrl: 'https://myaccount.google.com/apppasswords',
    webUrl: 'https://mail.google.com/',
    steps: [
      '打开 Google 账号的“安全性”，先开启两步验证。',
      '同一页点“应用专用密码”，备注填 知灯 Notewake，生成 16 位密码。',
      '回到这里填写 Gmail 地址和刚生成的应用专用密码，点验证即可。不要填网页登录密码。',
    ],
  },
  outlook: {
    provider: 'outlook',
    name: 'Outlook / Microsoft 365',
    passwordLabel: '应用密码',
    helpUrl: 'https://account.live.com/proofs/AppPassword',
    webUrl: 'https://outlook.live.com/mail/',
    steps: [
      '登录 Microsoft 账号并开启两步验证。',
      '在安全设置里创建“应用密码”。',
      '把 Outlook 邮箱和应用密码填到这里并验证。',
    ],
  },
  icloud: {
    provider: 'icloud',
    name: 'iCloud 邮箱',
    passwordLabel: 'App 专用密码',
    helpUrl: 'https://appleid.apple.com/account/manage',
    webUrl: 'https://www.icloud.com/mail/',
    steps: [
      '打开 Apple ID 网页并开启双重认证。',
      '在“App 专用密码”生成一组密码。',
      '填写 iCloud 邮箱和这组专用密码后验证。',
    ],
  },
  yahoo: {
    provider: 'yahoo',
    name: 'Yahoo 邮箱',
    passwordLabel: '应用密码',
    helpUrl: 'https://login.yahoo.com/account/security',
    webUrl: 'https://mail.yahoo.com/',
    steps: [
      '打开 Yahoo 账号安全页并开启两步验证。',
      '生成第三方应用密码。',
      '填写 Yahoo 邮箱和应用密码后验证。',
    ],
  },
  qq: {
    provider: 'qq',
    name: 'QQ 邮箱',
    passwordLabel: '授权码',
    helpUrl: 'https://wx.mail.qq.com/account',
    webUrl: 'https://mail.qq.com/',
    steps: [
      '打开 QQ 邮箱网页，进入设置 → 账户。',
      '开启 IMAP，并生成授权码。',
      '填写 QQ 邮箱和授权码，不要填 QQ 密码。',
    ],
  },
  '163': {
    provider: '163',
    name: '163 邮箱',
    passwordLabel: '授权码',
    helpUrl: 'https://mail.163.com/',
    webUrl: 'https://mail.163.com/',
    steps: [
      '打开 163 邮箱设置，开启 IMAP。',
      '生成客户端授权码。',
      '填写 163 邮箱和授权码后验证。',
    ],
  },
}

export function getTodoMailGuide(provider: TodoMailProvider): TodoMailGuide | null {
  if (provider === 'custom') return null
  return GUIDES[provider]
}

export function recommendedTodoMailProvider(): TodoMailProvider {
  return 'gmail'
}
