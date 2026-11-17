'use strict';
// Shared lifecycle reducer for hook-based read-only providers (WorkBuddy, Antigravity).
// Only normalized metadata enters this reducer; prompts/tool arguments never do.
const { hookProvidersMap } = require('../connectors/catalog.cjs');
const ACTIVE_TTL = 30 * 60_000;
const BLOCKED_TTL = ACTIVE_TTL;
const HISTORY_TTL = 24 * 60 * 60_000;
const LABELS = {
  running: '正在工作',
  waiting: '需要你确认',
  ready: '本轮结束',
  blocked: '遇到问题',
  cancelled: '已取消',
  idle: '空闲',
  unknown: '状态待更新',
  history: '历史记录',
};
const PROVIDERS = hookProvidersMap();
const QUESTION_TOOL = /ask_?question|ask_user|request_user_input/i;
const ANTIGRAVITY_BLOCKED_REASONS = new Set([
  'ERROR',
  'MAX_INVOCATIONS',
  'MAX_FORCED_INVOCATIONS',
  'MAX_TOKEN_BUDGET_EXCEEDED',
  'TERMINAL_CUSTOM_HOOK',
]);

function isWaitingTool(tools) {
  return Object.values(tools).some(name => QUESTION_TOOL.test(name));
}

function applyEvent(store, event, expectedProvider) {
  const provider = PROVIDERS[event?.provider];
  if (!provider || (expectedProvider && provider.id !== expectedProvider)) return false;
  if (event?.v !== 1 || typeof event.sessionId !== 'string' || !event.sessionId || event.sessionId.length > 256 || !Number.isFinite(event.at)) return false;
  if (event.at > Date.now() + 60_000) return false;
  if (['__proto__', 'constructor', 'prototype'].includes(event.sessionId)) return false;
  const prior = Object.hasOwn(store, event.sessionId) ? store[event.sessionId] : undefined;
  if (prior && (event.at < prior.updatedAt || prior.eventId === event.id)) return false;

  const row = prior ?? { sessionId: event.sessionId, status: 'idle', tools: {}, lastSeq: 0 };
  if (typeof event.workspace === 'string' && event.workspace.trim()) row.workspace = event.workspace.slice(0, 64);
  if (typeof event.workspacePath === 'string' && event.workspacePath.trim()) {
    row.workspacePath = event.workspacePath.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 512);
  }
  if (typeof event.sessionTitle === 'string') {
    const cleanedTitle = event.sessionTitle.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (cleanedTitle) row.sessionTitle = cleanedTitle;
  }
  const tool = typeof event.tool === 'string' ? event.tool.slice(0, 100) : '';
  const toolId = String(event.toolId || tool || 'tool').slice(0, 256);
  if (['__proto__', 'constructor', 'prototype'].includes(toolId)) return false;

  switch (event.event) {
    case 'SessionStart':
      break; // Hooks may emit SessionStart after the first turn event.
    case 'UserPromptSubmit':
    case 'PreInvocation':
      row.status = 'running';
      row.tools = {};
      row.detail = '正在思考';
      break;
    case 'PreToolUse':
      row.tools[toolId] = tool;
      row.status = isWaitingTool(row.tools) ? 'waiting' : 'running';
      row.detail = row.status === 'waiting' ? `需要你在 ${provider.label} 中回答` : `正在使用 ${tool || '工具'}`;
      break;
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      delete row.tools[toolId];
      if (prior && ['ready', 'idle', 'blocked', 'cancelled'].includes(row.status)) break;
      const failed = event.event === 'PostToolUseFailure' || Boolean(event.hasError);
      row.status = isWaitingTool(row.tools) ? 'waiting' : 'running';
      row.detail = row.status === 'waiting'
        ? `需要你在 ${provider.label} 中回答`
        : failed ? '工具执行遇到问题，Agent 正在处理' : '正在思考';
      break;
    }
    case 'PostInvocation':
      if (!['ready', 'idle', 'blocked', 'cancelled', 'waiting'].includes(row.status)) {
        row.status = 'running';
        row.detail = '正在思考';
      }
      break;
    case 'Notification':
      if (['permission_prompt', 'elicitation_dialog', 'idle_prompt'].includes(event.notification)) {
        row.status = 'waiting';
        row.detail = `需要你在 ${provider.label} 中处理`;
      }
      break;
    case 'PermissionRequest':
      row.status = 'waiting';
      row.detail = `需要你在 ${provider.label} 中确认`;
      break;
    case 'PermissionDenied':
      row.status = 'running';
      row.detail = '操作未获批准，等待 Agent 后续处理';
      break;
    case 'Stop': {
      row.tools = {};
      const reason = String(event.terminationReason || '');
      if (reason === 'USER_CANCELED') {
        row.status = 'cancelled';
        row.detail = '本轮已取消';
      } else if (ANTIGRAVITY_BLOCKED_REASONS.has(reason) || event.hasError) {
        row.status = 'blocked';
        row.detail = `本轮执行异常，请在 ${provider.label} 查看`;
      } else {
        row.status = 'ready';
        row.detail = `本轮已结束，请在 ${provider.label} 查看结果`;
      }
      break;
    }
    case 'StopFailure':
      row.status = 'blocked';
      row.tools = {};
      row.detail = `本轮执行失败，请在 ${provider.label} 查看`;
      break;
    case 'SessionEnd':
      row.status = 'idle';
      row.tools = {};
      row.detail = '会话已结束';
      break;
    default:
      return false;
  }

  row.updatedAt = event.at;
  row.eventId = event.id;
  row.lastSeq++;
  store[event.sessionId] = row;
  return true;
}

function sessionRows(store, providerId = 'workbuddy', now = Date.now()) {
  const provider = PROVIDERS[providerId];
  if (!provider) throw new Error(`Unknown hook provider: ${providerId}`);
  return Object.values(store).filter(row => now - row.updatedAt < HISTORY_TTL).map(row => {
    const staleActive = ['running', 'waiting'].includes(row.status) && now - row.updatedAt > ACTIVE_TTL;
    const staleBlocked = row.status === 'blocked' && now - row.updatedAt > BLOCKED_TTL;
    const stale = staleActive || staleBlocked;
    const status = stale ? (staleBlocked ? 'history' : 'unknown') : row.status;
    const shortId = row.sessionId.slice(-6);
    const title = row.sessionTitle
      ? (row.workspace ? `${row.workspace} · ${row.sessionTitle}` : row.sessionTitle)
      : (row.workspace ? `${row.workspace} · ${shortId}` : `任务 ${shortId}`);
    return {
      sessionId: `${provider.id}:${row.sessionId}`,
      provider: provider.id,
      providerLabel: provider.label,
      title,
      status,
      statusText: LABELS[status] ?? '空闲',
      detail: staleActive
        ? `一段时间未收到新事件，请在 ${provider.label} 查看`
        : staleBlocked
          ? `较早之前的失败记录（已超过 30 分钟），请在 ${provider.label} 查看`
          : row.detail || '等待任务',
      workspacePath: row.workspacePath || '',
      running: status === 'running',
      unread: ['ready', 'blocked', 'waiting'].includes(status),
      lastSeq: row.lastSeq,
      updatedAt: row.updatedAt,
      capabilities: { reply: false, cancel: false, open: true },
    };
  });
}

module.exports = { applyEvent, sessionRows, ACTIVE_TTL, BLOCKED_TTL, HISTORY_TTL, PROVIDERS };
