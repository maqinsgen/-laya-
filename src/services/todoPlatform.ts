import type {
  TodoCreateInput,
  TodoDashboardState,
  TodoFeedbackVote,
  TodoGoogleConnectInput,
  TodoGoogleConnectionState,
  TodoItem,
  TodoMailAccount,
  TodoMailAccountInput,
  TodoMailInboxResult,
  TodoScanResult,
  TodoSettings,
  TodoSyncConfigInput,
  TodoSyncResult,
  TodoSyncState,
  TodoUpdateInput,
} from '../types/todo'
import type { TodoJevConfigInput, TodoJevConfigState } from '../shared/todoJevConfig'

/**
 * 待办页的平台边界。Electron 是当前实现；Android/iOS 伴侣端可以
 * 提供同形状的 Capacitor/React Native adapter，不需要改页面组件。
 */
export interface TodoPlatformApi {
  getJevConfig(): Promise<TodoJevConfigState>
  configureJev(input: TodoJevConfigInput): Promise<{ success: boolean; state?: TodoJevConfigState; error?: string }>
  testJev(input: TodoJevConfigInput): Promise<{ success: boolean; error?: string }>
  getState(): Promise<TodoDashboardState>
  scan(force?: boolean): Promise<TodoScanResult>
  resetScan(): Promise<{ success: boolean; removedCount?: number; error?: string }>
  recordFeedback(id: string, vote: TodoFeedbackVote): Promise<{ success: boolean; item?: TodoItem; error?: string }>
  create(input: TodoCreateInput): Promise<{ success: boolean; item?: TodoItem; error?: string }>
  update(id: string, patch: TodoUpdateInput): Promise<{ success: boolean; item?: TodoItem; error?: string }>
  remove(id: string): Promise<{ success: boolean }>
  updateSettings(patch: Partial<TodoSettings>): Promise<{ success: boolean; settings?: TodoSettings; error?: string }>
  addMailAccount(input: TodoMailAccountInput): Promise<{ success: boolean; account?: TodoMailAccount; error?: string }>
  removeMailAccount(id: string): Promise<{ success: boolean }>
  listMailInbox(accountId: string, limit?: number): Promise<TodoMailInboxResult>
  connectGoogle(input: TodoGoogleConnectInput): Promise<{ success: boolean; state?: TodoGoogleConnectionState; error?: string }>
  disconnectGoogle(): Promise<{ success: boolean; state: TodoGoogleConnectionState }>
  exportCalendar(): Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }>
  addToCalendar(id: string): Promise<{ success: boolean; filePath?: string; error?: string }>
  applyWallpaper(): Promise<{ success: boolean; filePath?: string; error?: string }>
  configureSync(input: TodoSyncConfigInput): Promise<TodoSyncResult>
  syncNow(): Promise<TodoSyncResult>
  disconnectSync(): Promise<{ success: boolean; state: TodoSyncState }>
  openWeb(url: string, title: string): Promise<void>
}

function electronAdapter(): TodoPlatformApi {
  if (!window.electronAPI?.todo) throw new Error('当前平台尚未注册待办适配器')
  return {
    getJevConfig: () => window.electronAPI.todo.getJevConfig(),
    configureJev: (input) => window.electronAPI.todo.configureJev(input),
    testJev: (input) => window.electronAPI.todo.testJev(input),
    getState: () => window.electronAPI.todo.getState(),
    scan: (force) => window.electronAPI.todo.scan(force),
    resetScan: () => window.electronAPI.todo.resetScan(),
    recordFeedback: (id, vote) => window.electronAPI.todo.recordFeedback(id, vote),
    create: (input) => window.electronAPI.todo.create(input),
    update: (id, patch) => window.electronAPI.todo.update(id, patch),
    remove: (id) => window.electronAPI.todo.remove(id),
    updateSettings: (patch) => window.electronAPI.todo.updateSettings(patch),
    addMailAccount: (input) => window.electronAPI.todo.addMailAccount(input),
    removeMailAccount: (id) => window.electronAPI.todo.removeMailAccount(id),
    listMailInbox: (accountId, limit) => window.electronAPI.todo.listMailInbox(accountId, limit),
    connectGoogle: (input) => window.electronAPI.todo.connectGoogle(input),
    disconnectGoogle: () => window.electronAPI.todo.disconnectGoogle(),
    exportCalendar: () => window.electronAPI.todo.exportCalendar(),
    addToCalendar: (id) => window.electronAPI.todo.addToCalendar(id),
    applyWallpaper: () => window.electronAPI.todo.applyWallpaper(),
    configureSync: (input) => window.electronAPI.todo.configureSync(input),
    syncNow: () => window.electronAPI.todo.syncNow(),
    disconnectSync: () => window.electronAPI.todo.disconnectSync(),
    openWeb: (url, title) => window.electronAPI.window.openBrowserWindow(url, title),
  }
}

export const todoPlatform: TodoPlatformApi = {
  getJevConfig: () => electronAdapter().getJevConfig(),
  configureJev: (input) => electronAdapter().configureJev(input),
  testJev: (input) => electronAdapter().testJev(input),
  getState: () => electronAdapter().getState(),
  scan: (force) => electronAdapter().scan(force),
  resetScan: () => electronAdapter().resetScan(),
  recordFeedback: (id, vote) => electronAdapter().recordFeedback(id, vote),
  create: (input) => electronAdapter().create(input),
  update: (id, patch) => electronAdapter().update(id, patch),
  remove: (id) => electronAdapter().remove(id),
  updateSettings: (patch) => electronAdapter().updateSettings(patch),
  addMailAccount: (input) => electronAdapter().addMailAccount(input),
  removeMailAccount: (id) => electronAdapter().removeMailAccount(id),
  listMailInbox: (accountId, limit) => electronAdapter().listMailInbox(accountId, limit),
  connectGoogle: (input) => electronAdapter().connectGoogle(input),
  disconnectGoogle: () => electronAdapter().disconnectGoogle(),
  exportCalendar: () => electronAdapter().exportCalendar(),
  addToCalendar: (id) => electronAdapter().addToCalendar(id),
  applyWallpaper: () => electronAdapter().applyWallpaper(),
  configureSync: (input) => electronAdapter().configureSync(input),
  syncNow: () => electronAdapter().syncNow(),
  disconnectSync: () => electronAdapter().disconnectSync(),
  openWeb: (url, title) => electronAdapter().openWeb(url, title),
}
