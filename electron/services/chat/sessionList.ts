import { dbAdapter } from '../dbAdapter'
import { isOfficialAccountUsername, isOfficialFolderUsername, shouldKeepSession } from './accountUtils'
import { processSummary } from './contentParsers'
import { resolveWeComCorpName } from './weComResolver'
import type { ChatSession } from './types'
import type { ChatServiceState } from './state'

/**
 * 获取会话列表
 */
export async function getSessions(state: ChatServiceState, offset?: number, limit?: number): Promise<{ success: boolean; sessions?: ChatSession[]; hasMore?: boolean; error?: string }> {
  try {
    // 消费预加载缓存（仅首页请求）
    const isFirstPage = !offset || offset === 0
    if (isFirstPage && state.preloadCache.builtAt > 0 &&
        Date.now() - state.preloadCache.builtAt < state.PRELOAD_CACHE_TTL &&
        state.preloadCache.sessions) {
      const cached = state.preloadCache.sessions
      state.preloadCache.sessions = null
      return cached
    }

    // 获取表列表
    const tables = await dbAdapter.all<{ name: string }>(
      'session',
      '',
      "SELECT name FROM sqlite_master WHERE type='table'"
    )
    const tableNames = tables.map(t => t.name)

    // 查找会话表
    let sessionTableName: string | null = null
    for (const name of ['SessionTable', 'Session', 'session']) {
      if (tableNames.includes(name)) {
        sessionTableName = name
        break
      }
    }

    if (!sessionTableName) {
      return { success: false, error: '未找到会话表' }
    }

    // 查询数据（支持分页）
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0))
    const safeLimit = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 300)))
    const rows = await dbAdapter.all<any>(
      'session',
      '',
      `SELECT * FROM ${sessionTableName} ORDER BY sort_timestamp DESC LIMIT ? OFFSET ?`,
      [safeLimit + 1, safeOffset]
    )

    // 转换为 ChatSession
    const sessions: ChatSession[] = []
    for (const row of rows.slice(0, safeLimit)) {
      const username = row.username || row.user_name || row.userName || ''

      if (!shouldKeepSession(username)) continue

      const sortTs = row.sort_timestamp || row.sortTimestamp || 0
      const lastTs = row.last_timestamp || row.lastTimestamp || sortTs

      const isFoldGroup = username === '@placeholder_foldgroup'
      const isOfficialFolder = isOfficialFolderUsername(username)
      const isOfficialAccount = isOfficialAccountUsername(username)
      sessions.push({
        username,
        type: row.type || 0,
        unreadCount: row.unread_count || row.unreadCount || 0,
        summary: processSummary(row.summary || row.digest || '', row.last_msg_type || row.lastMsgType || 1),
        sortTimestamp: sortTs,
        lastTimestamp: lastTs,
        lastMsgType: row.last_msg_type || row.lastMsgType || 0,
        displayName: isFoldGroup ? '折叠的聊天' : isOfficialFolder ? '公众号' : username,
        isWeCom: !isFoldGroup && !isOfficialFolder && !isOfficialAccount && username.includes('@openim'),
        isFoldGroup: isFoldGroup || undefined,
        isOfficialFolder: isOfficialFolder || undefined,
        isOfficialAccount: isOfficialAccount || undefined
      })
    }

    // 获取联系人信息
    await enrichSessionsWithContacts(state, sessions)

    return { success: true, sessions, hasMore: rows.length > safeLimit }
  } catch (e) {
    console.error('ChatService: 获取会话列表失败:', e)
    return { success: false, error: String(e) }
  }
}

/**
 * 补充联系人信息
 */
async function enrichSessionsWithContacts(state: ChatServiceState, sessions: ChatSession[]): Promise<void> {
  if (sessions.length === 0) return

  try {
    // 检查 contact 表是否存在
    const tables = await dbAdapter.all<any>(
      'contact',
      '',
      "SELECT name FROM sqlite_master WHERE type='table' AND name='contact'"
    )

    if (tables.length === 0) {
      return
    }

    // 使用缓存的列信息
    if (!state.contactColumnsCache) {
      const columns = await dbAdapter.all<any>('contact', '', "PRAGMA table_info(contact)")
      const columnNames = columns.map((c: any) => c.name)

      const hasBigHeadUrl = columnNames.includes('big_head_url')
      const hasSmallHeadUrl = columnNames.includes('small_head_url')
      const hasExtraBuffer = columnNames.includes('extra_buffer')

      const selectCols = ['username', 'remark', 'nick_name', 'alias']
      if (hasBigHeadUrl) selectCols.push('big_head_url')
      if (hasSmallHeadUrl) selectCols.push('small_head_url')
      if (hasExtraBuffer) selectCols.push('extra_buffer')
      if (columnNames.includes('flag')) selectCols.push('flag')

      state.contactColumnsCache = { hasBigHeadUrl, hasSmallHeadUrl, hasExtraBuffer, selectCols }
    }

    const { hasBigHeadUrl, hasSmallHeadUrl, hasExtraBuffer, selectCols } = state.contactColumnsCache

    const usernames = Array.from(new Set(sessions.map(s => s.username).filter(Boolean)))
    if (usernames.length === 0) return

    const contacts: any[] = []
    for (let i = 0; i < usernames.length; i += 400) {
      const batch = usernames.slice(i, i + 400)
      const placeholders = batch.map(() => '?').join(',')
      const batchContacts = await dbAdapter.all<any>(
        'contact',
        '',
        `SELECT ${selectCols.join(', ')}
         FROM contact
         WHERE username IN (${placeholders})`,
        batch
      )
      contacts.push(...batchContacts)
    }
    const contactMap = new Map<string, any>(contacts.map((contact: any) => [contact.username, contact]))

    for (const session of sessions) {
      const contact = contactMap.get(session.username)
      if (!contact) continue
      if (!session.isFoldGroup && !session.isOfficialFolder) {
        session.displayName = contact.remark || contact.nick_name || contact.alias || session.displayName || session.username
      }
      if (hasBigHeadUrl && contact.big_head_url) {
        session.avatarUrl = contact.big_head_url
      } else if (hasSmallHeadUrl && contact.small_head_url) {
        session.avatarUrl = contact.small_head_url
      }
      if (session.isWeCom && hasExtraBuffer && contact.extra_buffer) {
        session.weComCorp = await resolveWeComCorpName(state, 
          contact.extra_buffer,
          [contact.remark, contact.nick_name, contact.alias, session.username]
        )
      }
      // contact.flag 位标记：第 11 位 (0x800) = 置顶；第 28 位 (0x10000000) = 折叠的群聊
      const flag = Number(contact.flag) || 0
      if (flag & 0x800) session.isPinned = true
      if (flag & 0x10000000) session.isCollapsed = true
    }
  } catch (e) {
    console.error('ChatService: 获取联系人信息失败:', e)
  }
}
