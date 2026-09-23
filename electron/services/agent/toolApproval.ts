import type { ToolApprovalConfiguration, ToolApprovalStatus, ToolSet } from 'ai'
import { ConfigService } from '../config'
import type { AgentRunInput } from './types'

const HIGH_RISK_TOOL_NAMES = new Set([
  'send_sticker',
  'send_random_image',
  'send_media_from_history',
  'send_wechat_media',
  'send_wechat_file',
  'export_chat',
  'create_artifact',
  'remove_knowledge_source',
  'create_task',
  'update_task',
  'cancel_task',
  'run_task_now',
  'rollback_operation',
  'apply_memory_fix',
  // Canvas 全文替换：中风险（只影响会话本地数据，但可能覆盖用户编辑），on-request 需审批
  'canvas_replace',
])

// "替我审批"（risk-based）策略下自动放行的低风险工具：影响面小且可逆（发表情包、任务的增删改）。
// 其余高风险工具名单（发任意媒体/文件、导出、删知识来源、回滚、改记忆、立即运行任务）和所有 MCP 工具仍按高风险处理。
const LOW_RISK_TOOL_NAMES = new Set([
  'send_sticker',
  'create_task',
  'update_task',
  'cancel_task',
  // 中风险：有 revision 快照可从版本历史恢复，risk-based 下放行
  'canvas_replace',
])

const APPROVAL_POLICY_CONFIG_KEY = 'agentToolApprovalPolicy'

function approvalReason(toolName: string): string {
  if (toolName.startsWith('mcp__') || toolName.startsWith('mcp_')) return '外部 MCP 工具需要用户确认'
  if (toolName.startsWith('send_')) return '发送微信消息、媒体或文件需要用户确认'
  if (toolName === 'export_chat' || toolName === 'create_artifact') return '导出或写入本机文件需要用户确认'
  if (toolName === 'canvas_replace') return '全文替换画布内容需要用户确认'
  if (toolName.endsWith('_task') || toolName === 'run_task_now') return '主动/定时任务变更需要用户确认'
  if (toolName.includes('memory')) return '修改长期记忆需要用户确认'
  return '高风险工具调用需要用户确认'
}

function readConfiguredApprovalPolicy(): 'on-request' | 'risk-based' | 'full-access' {
  const config = new ConfigService()
  try {
    const value = config.get(APPROVAL_POLICY_CONFIG_KEY as any)
    return value === 'risk-based' || value === 'full-access' ? value : 'on-request'
  } finally {
    config.close()
  }
}

export function buildAgentToolApproval(
  input: AgentRunInput,
  mcpToolNames: readonly string[] = [],
): ToolApprovalConfiguration<ToolSet, unknown> | undefined {
  // 微信机器人入口没有当前 Agent 页审批 UI；该入口只允许当前触发会话的受控回复附件。
  if (input.outputMode === 'wechat') return undefined

  const policy = readConfiguredApprovalPolicy()
  if (policy === 'full-access') return undefined

  const mcpTools = new Set(mcpToolNames)
  return ({ toolCall }): ToolApprovalStatus => {
    const toolName = String(toolCall.toolName || '')
    if (!HIGH_RISK_TOOL_NAMES.has(toolName) && !mcpTools.has(toolName)) return undefined
    if (policy === 'risk-based' && LOW_RISK_TOOL_NAMES.has(toolName)) return undefined
    return { type: 'user-approval', reason: approvalReason(toolName) }
  }
}
