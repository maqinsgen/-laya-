import { dialog, ipcMain } from 'electron'
import { todoService } from '../../services/todoService'
import { todoSyncService } from '../../services/todoSyncService'
import { todoGoogleService } from '../../services/todoGoogleService'
import { todoJevConfigService, todoJevConfigErrorMessage } from '../../services/todoJevConfigService'
import type { TodoJevConfigInput } from '../../../src/shared/todoJevConfig'
import type { TodoCreateInput, TodoFeedbackVote, TodoGoogleConnectInput, TodoMailAccountInput, TodoSettings, TodoSyncConfigInput, TodoUpdateInput } from '../../../src/types/todo'
import type { MainProcessContext } from '../context'

export function registerTodoHandlers(ctx: MainProcessContext): void {
  todoService.start()
  todoSyncService.start()

  ipcMain.handle('todo:getState', () => todoService.getState())
  ipcMain.handle('todo:getJevConfig', () => {
    try { return todoJevConfigService.getState() }
    catch { throw new Error('读取 Jev 配置失败，请稍后重试。') }
  })
  ipcMain.handle('todo:configureJev', (_, input: TodoJevConfigInput) => {
    try { return { success: true, state: todoJevConfigService.configure(input) } }
    catch (error) { return { success: false, error: todoJevConfigErrorMessage(error) } }
  })
  ipcMain.handle('todo:testJev', (_, input: TodoJevConfigInput) => todoJevConfigService.test(input))

  ipcMain.handle('todo:scan', async (_, force?: boolean) => {
    const result = await todoService.scanWechat(Boolean(force))
    if (!result.success) {
      ctx.getLogService()?.warn('Todo', '待办扫描失败', { error: result.error })
    }
    return result
  })

  ipcMain.handle('todo:resetScan', () => {
    try {
      return { success: true, removedCount: todoService.resetScan() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('todo:recordFeedback', (_, id: string, vote: TodoFeedbackVote) => {
    try {
      return { success: true, item: todoService.recordFeedback(id, vote) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('todo:create', (_, input: TodoCreateInput) => {
    try {
      return { success: true, item: todoService.create(input) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('todo:update', (_, id: string, patch: TodoUpdateInput) => {
    try {
      return { success: true, item: todoService.update(id, patch) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('todo:remove', (_, id: string) => ({ success: todoService.remove(id) }))

  ipcMain.handle('todo:updateSettings', (_, patch: Partial<TodoSettings>) => {
    try {
      return { success: true, settings: todoService.updateSettings(patch) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('todo:addMailAccount', async (_, input: TodoMailAccountInput) => {
    try {
      return { success: true, account: await todoService.addMailAccount(input) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('todo:removeMailAccount', (_, id: string) => ({ success: todoService.removeMailAccount(id) }))
  ipcMain.handle('todo:listMailInbox', (_, accountId: string, limit?: number) => todoService.listMailInbox(accountId, limit))

  ipcMain.handle('todo:connectGoogle', async (_, input: TodoGoogleConnectInput) => {
    try {
      return { success: true, state: await todoGoogleService.connect(input) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('todo:disconnectGoogle', () => ({ success: true, state: todoGoogleService.disconnect() }))

  ipcMain.handle('todo:exportCalendar', async () => {
    const result = await dialog.showSaveDialog({
      title: '导出待办日历',
      defaultPath: `CipherTalk-Todo-${new Date().toISOString().slice(0, 10)}.ics`,
      filters: [{ name: 'iCalendar', extensions: ['ics'] }],
    })
    if (result.canceled || !result.filePath) return { success: false, canceled: true }
    return todoService.exportCalendar(result.filePath)
  })

  ipcMain.handle('todo:addToCalendar', (_, id: string) => todoService.addToCalendar(id))

  ipcMain.handle('todo:applyWallpaper', async () => todoService.applyWallpaper())

  ipcMain.handle('todo:configureSync', (_, input: TodoSyncConfigInput) => {
    try {
      return todoSyncService.configure(input)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('todo:syncNow', async () => todoSyncService.syncNow())
  ipcMain.handle('todo:disconnectSync', () => ({ success: true, state: todoSyncService.disconnect() }))
}
