/** Read committed DSH events without interpreting tool text as executable markup. */
export function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content.filter(p => p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
}

/**
 * Codex Pet's activity subtitles distinguish calling/called a tool, editing
 * files, running a command and searching the web. DSH only records a tool
 * name, so derive the category from the name. Never guess file counts or patch
 * +/- lines: those are not in the event stream and would be fabricated data.
 */
export function toolCategory(name) {
  const value = String(name ?? '').toLowerCase();
  if (!value) return 'generic';
  if (/(edit|write|patch|replace|create_file|delete_file|notebook)/.test(value)) return 'edit';
  if (/(shell|bash|terminal|exec|command|pwsh|powershell|pty)/.test(value)) return 'command';
  if (/(web|search|fetch|browse|crawl)/.test(value)) return 'web';
  return 'generic';
}

/** One Codex-style subtitle for a tool, in the language the pet UI uses. */
export function toolPhrase(name, ongoing) {
  switch (toolCategory(name)) {
    case 'edit': return ongoing ? '正在编辑文件' : '已编辑文件';
    case 'command': return ongoing ? '正在运行命令' : '已运行命令';
    case 'web': return ongoing ? '正在搜索网页' : '已搜索网页';
    default: return ongoing ? `正在调用 ${name}` : `已调用 ${name}`;
  }
}

const statusTexts = { waiting: '需要输入', blocked: '受阻', ready: '已完成', running: '正在思考', cancelled: '已取消', idle: '空闲' };

/** Build status and conversation from one authoritative event prefix. */
export function sessionView(events, { running = false, projections = {}, seen = -1 } = {}) {
  const approvals = new Map();
  const questions = new Set();
  const tools = new Map();
  const messages = [];
  const counts = { edit: 0, command: 0, web: 0 };
  let end, lastSeq = -1, lastTool, todos;
  for (const event of events) {
    lastSeq = event.seq;
    const d = event.data;
    switch (event.type) {
      case 'turn/start': end = undefined; lastTool = undefined; todos = undefined; break;
      case 'todo/write': todos = Array.isArray(d.todos) ? d.todos : undefined; break;
      case 'approval/asked':
        approvals.set(d.id, { id: String(d.id), toolName: typeof d.toolName === 'string' ? d.toolName : '',
          reason: typeof d.reason === 'string' ? d.reason : '' });
        break;
      case 'approval/decided': approvals.delete(d.id); break;
      case 'tool/call':
        tools.set(d.callId, d.name);
        lastTool = d.name;
        counts[toolCategory(d.name)] += 1;
        if (d.name === 'ask_user_question') questions.add(d.callId);
        break;
      case 'tool/result': tools.delete(d.callId); questions.delete(d.callId); break;
      case 'user/message': {
        // DSH also records runtime context and plugin instructions as user/message.
        // Only human-authored messages belong in the companion conversation.
        if (d.source?.kind !== 'user') break;
        const text = textOf(d.content);
        const attachments = (d.content ?? []).filter(p => p.type === 'image' || p.type === 'file').length;
        if (text || attachments) messages.push({ role: 'user', text, attachments, seq: event.seq });
        break;
      }
      case 'assistant/message': {
        const text = textOf(d.message?.content);
        if (text) messages.push({ role: 'assistant', text, seq: event.seq });
        break;
      }
      case 'turn/end': end = { ...d.reason, seq: event.seq }; tools.clear(); questions.clear(); approvals.clear(); break;
      default: break;
    }
  }
  const pending = [...approvals.values()];
  const waiting = approvals.size > 0 || questions.size > 0 || (projections.userQuestions?.active?.length ?? 0) > 0;
  const status = waiting ? 'waiting' : end?.kind === 'error' || ['blocked', 'max-tokens', 'interrupted'].includes(end?.kind) ? 'blocked'
    : running ? 'running' : end?.kind === 'completed' ? 'ready' : end?.kind === 'aborted' ? 'cancelled' : 'idle';
  const activeTodo = todos?.findLast(todo => todo?.status === 'in_progress')
    ?? todos?.find(todo => todo?.status === 'pending');
  const activeTool = tools.size ? [...tools.values()].at(-1) : undefined;
  // A pending approval carries the real tool name and reason; showing those is
  // the closest faithful equivalent to Codex's "Allow / Allow once" card. The
  // decision itself stays in DSH: approvals are decided by a same-process
  // waterfall that the out-of-process pet cannot safely join.
  const detail = waiting
    ? pending.length ? `需要批准 ${pending[0].toolName || '操作'}` : questions.size || projections.userQuestions?.active?.length ? '需要回答问题' : '需要你在 DSH 中确认或回答'
    : status === 'blocked' ? (end?.error?.message ?? '任务受阻，请打开 DSH 查看')
      : status === 'ready' && lastTool ? toolPhrase(lastTool, false)
        : running ? activeTodo?.content ?? (activeTool ? toolPhrase(activeTool, true) : '正在思考') : '';
  const progress = ['running', 'waiting'].includes(status) && todos?.length
    ? { completed: todos.filter(todo => todo?.status === 'completed').length, total: todos.length }
    : undefined;
  return { status, statusText: statusTexts[status] ?? '空闲', detail,
    ...(pending.length ? { pending } : {}),
    ...(activeTool || lastTool ? { activity: { name: activeTool ?? lastTool, category: toolCategory(activeTool ?? lastTool), ongoing: Boolean(activeTool), counts } } : {}),
    ...(progress ? { progress } : {}), unread: (status === 'ready' || status === 'blocked') && (end?.seq ?? -1) > seen,
    lastSeq, messages: messages.slice(-60) };
}

const priority = { waiting: 0, blocked: 1, ready: 2, running: 3, cancelled: 4, idle: 5 };
/** Attention first, then current work, then recent history. */
export function sortSessions(items) {
  return [...items].sort((a, b) => {
    const rank = s => s.status === 'ready' && !s.unread ? 5 : priority[s.status] ?? 5;
    return rank(a) - rank(b) || b.updatedAt - a.updatedAt;
  });
}
