import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import TodoPage from './pages/TodoPage'
import WelcomePage from './pages/WelcomePage'
import SplashPage from './pages/SplashPage'
import { buildWechatPreflight } from './shared/wechatConnection'
import AISummarySettings from './components/ai/AISummarySettings'
import { Toast } from '@heroui/react'
import { applyTodoFeedback, learnTodoPreferences } from './shared/todoIntelligence'
import { DEFAULT_LAYA_ENDPOINT, DEFAULT_LAYA_MODEL } from './shared/todoJevConfig'
import type { TodoUpdateInput, TodoSettings, TodoDashboardState } from './types/todo'
import './styles/tailwind.css'
import './styles/main.css'

const previewParams = new URLSearchParams(window.location.search)
const welcomePreview = import.meta.env.DEV && previewParams.has('welcome-preview')
const todoPreview = import.meta.env.DEV && previewParams.has('todo-preview')
const aiSetupPreview = import.meta.env.DEV && previewParams.has('ai-setup-preview')
const splashPreview = import.meta.env.DEV && previewParams.has('splash-preview')

if ((todoPreview || aiSetupPreview || welcomePreview) && !window.electronAPI) {
  const now = Date.now()
  const previewConfig: Record<string, unknown> = {
    aiCurrentProvider: 'deepseek',
    aiProviderConfigs: {
      deepseek: { apiKey: '', model: 'deepseek-chat' },
    },
    aiConfigPresets: [],
    aiActiveConfigPresetId: '',
    aiProviderModelCache: {},
  }
  const previewState: TodoDashboardState = {
    aiConfigured: false,
    scanning: false,
    items: [
      {
        insight: { kind: 'action', score: 92, baseScore: 92, adjustment: 0, reason: '对方明确请你确认付款节点，且明天截止，会影响项目交付。', topics: ['项目交付', '合同'] },
        id: 'preview-1',
        title: '记得明天帮我确认一下合同里的付款节点，然后回复我。',
        details: '',
        dueAt: null,
        evidence: { engine: 'jev', messageQuote: '记得明天帮我确认一下合同里的付款节点，然后回复我。', dateQuote: '明天', date: new Date(now + 24 * 60 * 60 * 1000).toLocaleDateString('sv-SE'), dateStatus: 'date-only', needsReview: true, decisionConfidence: 0.96 },
        priority: 'high',
        status: 'pending',
        sourceType: 'wechat',
        sourceLabel: '小林 · 项目组',
        sourceRef: 'preview:1',
        sourcePreview: '记得明天帮我确认一下合同里的付款节点，然后回复我。',
        confidence: 0.96,
        createdAt: now,
        updatedAt: now,
      },
      {
        insight: { kind: 'action', score: 68, baseScore: 68, adjustment: 0, reason: '例会材料与你的项目职责有关，距离截止仍有准备时间。', topics: ['产品', '团队协作'] },
        id: 'preview-2',
        title: '下周一准备产品例会演示',
        details: '整理上周用户反馈与新功能截图。',
        dueAt: new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString(),
        priority: 'medium',
        status: 'pending',
        sourceType: 'drive',
        sourceLabel: 'Roadmap / Q3',
        sourceRef: 'preview:2',
        sourcePreview: '这份 Drive 里有例会演示结构，下周一记得准备。',
        confidence: 0.89,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'preview-3',
        title: '给父母预约周末体检',
        details: '',
        dueAt: null,
        priority: 'low',
        status: 'pending',
        sourceType: 'manual',
        sourceLabel: '手动创建',
        sourceRef: 'preview:3',
        sourcePreview: '',
        confidence: 1,
        createdAt: now,
        updatedAt: now,
      },
    ],
    scan: {
      lastScanAt: now,
      lastSuccessfulScanAt: now - 15 * 60 * 1000,
      lastAutoScanDay: '',
      processedFingerprints: [],
      analyzedMessages: 47,
      extractedTodos: 3,
      lastError: '',
      lastDecisionEngine: 'jev', lastDecisionRequests: 2, lastSentMessages: 12, lastCacheHits: 35, lastRuleSkipped: 2, lastReviewItems: 1,
    },
    settings: {
      autoScanEnabled: true,
      scanHour: 20,
      reminderEnabled: true,
      remindBeforeMinutes: 30,
      wallpaperEnabled: false,
      connectors: [],
    },
    mailAccounts: [],
    google: {
      configured: true,
      connected: true,
      email: 'demo@gmail.com',
      clientId: 'preview.apps.googleusercontent.com',
      scopes: ['gmail.readonly', 'drive.readonly'],
      lastSyncAt: now - 12 * 60 * 1000,
      lastError: '',
    },
    sync: {
      configured: false,
      enabled: false,
      endpoint: '',
      username: '',
      remotePath: 'CipherTalk/todos.enc.json',
      autoSync: true,
      includeSourcePreview: false,
      deviceId: 'preview-device',
      lastSyncAt: 0,
      lastError: '',
      syncing: false,
    },
  }
  ;(window as any).electronAPI = {
    todo: {
      getJevConfig: async () => ({ enabled: false, backend: 'laya', hasApiKey: false, endpoint: DEFAULT_LAYA_ENDPOINT, model: DEFAULT_LAYA_MODEL }),
      configureJev: async () => ({ success: false, error: '演示模式不保存密钥，请在桌面应用配置。' }),
      testJev: async () => ({ success: false, error: '演示模式不调用外部服务，请在桌面应用测试。' }),
      getState: async () => {
        const learned = learnTodoPreferences(previewState.items)
        return structuredClone({ ...previewState, profile: {
          summary: previewState.settings.personalContext || '填写你的关注方向，或用明确反馈帮助助手了解你。',
          roles: [], usefulCount: learned.useful, uselessCount: learned.notUseful,
        } })
      },
      scan: async () => ({ success: true, analyzedMessages: 0, addedTodos: 0 }),
      resetScan: async () => ({ success: false, error: '演示不清空数据' }),
      recordFeedback: async (id: string, vote: 'useful' | 'useless' | 'not-useful' | null) => {
        const item = previewState.items.find((item) => item.id === id)
        if (!item) return { success: false }
        const next = applyTodoFeedback(item, vote === 'useless' ? 'not-useful' : vote)
        previewState.items = previewState.items.map((item) => item.id === id ? next : item)
        return { success: true, item: next }
      },
      create: async () => ({ success: false, error: '预览模式不保存数据' }),
      update: async (id: string, patch: TodoUpdateInput) => {
        const item = previewState.items.find((item) => item.id === id)
        if (!item) return { success: false }
        const next = patch.feedback !== undefined ? applyTodoFeedback(item, patch.feedback) : { ...item, ...patch, updatedAt: Date.now() }
        if (patch.dueAt !== undefined && next.evidence) next.evidence = { ...next.evidence, dateStatus: 'user-confirmed', date: undefined, dateQuote: undefined, needsReview: next.insight?.kind === 'information' && next.evidence.needsReview }
        previewState.items = previewState.items.map((item) => item.id === id ? next : item)
        return { success: true, item: next }
      },
      remove: async () => ({ success: false }),
      updateSettings: async (patch: Partial<TodoSettings>) => { previewState.settings = { ...previewState.settings, ...patch }; return { success: true, settings: previewState.settings } },
      addMailAccount: async () => ({ success: false, error: '预览模式' }),
      removeMailAccount: async () => ({ success: false }),
      listMailInbox: async () => ({
        success: true,
        accountLabel: 'demo@gmail.com',
        messages: [
          {
            id: 'preview-mail-1',
            accountId: 'google-oauth',
            provider: 'google-oauth',
            subject: '项目周会材料与下周安排',
            from: '小林 <lin@example.com>',
            to: 'demo@gmail.com',
            receivedAt: now - 35 * 60 * 1000,
            snippet: '附件是本周项目材料，请在下周一上午前确认演示顺序。',
            body: '你好，\n\n附件是本周项目材料，请在下周一上午前确认演示顺序，并把最终版本同步给项目组。\n\n谢谢。',
            hasAttachments: true,
          },
          {
            id: 'preview-mail-2',
            accountId: 'google-oauth',
            provider: 'google-oauth',
            subject: '体检预约确认',
            from: '服务中心 <service@example.com>',
            to: 'demo@gmail.com',
            receivedAt: now - 4 * 60 * 60 * 1000,
            snippet: '你的周末体检时间已预留，请在周五前确认。',
            body: '你的周末体检时间已预留，请在周五前确认。如需修改时间，请通过官方应用操作。',
            hasAttachments: false,
          },
        ],
      }),
      connectGoogle: async () => ({ success: false, error: '预览模式' }),
      disconnectGoogle: async () => ({ success: true, state: previewState.google }),
      exportCalendar: async () => ({ success: false, canceled: true }),
      addToCalendar: async () => ({ success: true, filePath: '/preview/todo.ics' }),
      applyWallpaper: async () => ({ success: false, error: '预览模式' }),
      configureSync: async () => ({ success: false, error: '预览模式' }),
      syncNow: async () => ({ success: false, error: '预览模式' }),
      disconnectSync: async () => ({ success: true, state: previewState.sync }),
    },
    config: {
      get: async (key: string) => previewConfig[key],
      set: async (key: string, value: unknown) => { previewConfig[key] = value },
    },
    accounts: {
      list: async () => [],
      getActive: async () => null,
      save: async (profile: Record<string, unknown>) => ({ ...profile, id: 'preview-account' }),
      setActive: async () => ({ id: 'preview-account' }),
    },
    ai: {
      getProviders: async () => [
        {
          id: 'deepseek',
          name: 'deepseek',
          displayName: 'DeepSeek',
          description: '官方文本模型 API',
          baseURL: 'https://api.deepseek.com',
          models: ['deepseek-chat', 'deepseek-reasoner'],
          modelDetails: [],
          pricing: '按量计费',
          pricingDetail: { input: 0, output: 0 },
          website: 'https://platform.deepseek.com/api_keys',
          protocol: 'openai-compatible',
        },
        {
          id: 'siliconflow-cn',
          name: 'siliconflow-cn',
          displayName: 'SiliconFlow',
          description: '多种开源文本模型',
          baseURL: 'https://api.siliconflow.cn/v1',
          models: ['Qwen/Qwen3-8B'],
          modelDetails: [],
          pricing: '按量计费',
          pricingDetail: { input: 0, output: 0 },
          website: 'https://docs.siliconflow.cn',
          protocol: 'openai-compatible',
        },
      ],
      listModels: async () => ({ success: true, models: ['deepseek-chat', 'deepseek-reasoner'], modelDetails: [] }),
      testConnection: async (_provider: string, apiKey: string) => apiKey.trim()
        ? ({ success: true, message: '预览连接成功' })
        : ({ success: false, error: '请填写 API 密钥' }),
      readGuide: async () => ({ success: true, content: '# 预览指南\n\n请使用服务商官方文档。' }),
    },
    app: { getPlatformInfo: async () => ({ platform: 'darwin', arch: 'arm64' }) },
    shell: { openExternal: async () => undefined, openPath: async () => '' },
    dbPath: {
      getBestCachePath: async () => ({ success: true, path: '/Demo/Cache' }),
      autoDetect: async () => ({ success: true, path: '/Demo/WeChat' }),
      scanWxids: async () => ['wxid_demo'],
    },
    wxKey: {
      preflight: async () => buildWechatPreflight({ platform: 'darwin', arch: 'arm64', running: true, componentReady: true, database: 'ready', security: previewParams.get('welcome-preview') === 'blocked' ? 'enabled' : 'disabled' }),
      startGetKey: async () => ({ success: true, key: 'a'.repeat(64), validatedWxid: 'wxid_demo' }),
      cancel: async () => true,
      onStatus: () => () => undefined,
      detectCurrentAccount: async () => ({ wxid: 'wxid_demo', dbPath: '/Demo/WeChat' }),
    },
    wcdb: {
      testConnection: async (_path: string, key: string) => ({ success: key === 'a'.repeat(64), error: '示例密钥为64个小写a' }),
      resolveValidWxid: async () => ({ success: true, wxid: 'wxid_demo' }),
    },
    imageKey: { onProgress: () => () => undefined },
    window: { openBrowserWindow: async () => undefined },
  }
}

ReactDOM.createRoot(document.getElementById('app')!).render(
  <React.StrictMode>
    <HashRouter>
      {splashPreview ? <SplashPage /> : aiSetupPreview ? (
        <div className="h-screen overflow-hidden bg-background p-6">
          <div className="settings-page">
            <Toast.Provider className="ct-toast-region" placement="top" />
            <div className="settings-body pt-6">
              <AISummarySettings showMessage={(text, success) => console.info(success ? '[preview:success]' : '[preview:error]', text)} />
            </div>
          </div>
        </div>
      ) : welcomePreview ? (
        <><div role="status" className="bg-amber-50 p-2 text-center text-xs text-amber-900">连接向导演示 · 使用虚构目录与密钥，不读取微信或修改系统</div><WelcomePage /></>
      ) : todoPreview ? (
        <>
          <Toast.Provider className="ct-toast-region" placement="top" />
          <div role="status" className="bg-blue-50 px-6 py-2 text-center text-xs text-blue-700">交互演示 · 使用示例消息，刷新后恢复；实际使用请启动桌面应用</div>
          <TodoPage />
        </>
      ) : <App />}
    </HashRouter>
  </React.StrictMode>
)
