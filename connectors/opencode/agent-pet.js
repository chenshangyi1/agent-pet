/**
 * Non-blocking OpenCode plugin for Agent Pet.
 * Writes sanitized session lifecycle metadata to $AGENT_PET_DATA/opencode/inbox.
 * Never logs prompts, tool inputs, or model responses.
 */
import { mkdirSync, openSync, writeSync, closeSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const BAD_IDS = new Set(['__proto__', 'constructor', 'prototype']);

function clean(value, limit) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function inboxDir() {
  const base = process.env.AGENT_PET_DATA || process.env.DSH_COMPANION_DATA || join(homedir(), '.dsh', 'companion');
  return join(base, 'opencode', 'inbox');
}

function writeEvent(payload) {
  try {
    const id = randomUUID().replace(/-/g, '');
    const record = { v: 1, provider: 'opencode', id, at: Date.now(), ...payload };
    const dir = inboxDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.${id}.${process.pid}.tmp`);
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, JSON.stringify(record), null, 'utf8');
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, join(dir, `${id}.json`));
  } catch {
    // Non-blocking observer: never disturb OpenCode execution.
  }
}

export const AgentPetPlugin = async ({ directory } = {}) => {
  const workspacePath = typeof directory === 'string'
    ? directory.replace(/[\r\n\t]+/g, ' ').trim().replace(/[/\\]+$/, '').slice(0, 512)
    : '';
  const workspace = clean(workspacePath ? basename(workspacePath) : '', 64);
  const wsFields = {
    ...(workspace ? { workspace } : {}),
    ...(workspacePath ? { workspacePath } : {}),
  };

  return {
    event: async ({ event }) => {
      if (!event || typeof event !== 'object') return;
      const props = event.properties || event.data || {};
      const sessionId = clean(props.sessionID || props.sessionId || props.id || '', 256);
      if (!sessionId || BAD_IDS.has(sessionId)) return;

      if (event.type === 'session.created') {
        writeEvent({ sessionId, event: 'SessionStart', ...wsFields });
      } else if (event.type === 'session.idle') {
        writeEvent({ sessionId, event: 'Stop', ...wsFields });
      } else if (event.type === 'session.error') {
        writeEvent({ sessionId, event: 'StopFailure', hasError: true, ...wsFields });
      } else if (event.type === 'session.status') {
        const statusType = clean(props.status?.type || props.status || '', 32).toLowerCase();
        if (statusType === 'busy' || statusType === 'running' || statusType === 'retry') {
          writeEvent({ sessionId, event: 'UserPromptSubmit', ...wsFields });
        } else if (statusType === 'idle') {
          writeEvent({ sessionId, event: 'Stop', ...wsFields });
        }
      }
    },

    'tool.execute.before': async (input) => {
      const sessionId = clean(input?.sessionID || input?.sessionId || '', 256);
      const tool = clean(input?.tool || '', 100);
      const toolId = clean(input?.callID || input?.callId || '', 256);
      if (!sessionId || BAD_IDS.has(sessionId)) return;
      writeEvent({ sessionId, event: 'PreToolUse', ...(tool ? { tool } : {}), ...(toolId ? { toolId } : {}), ...wsFields });
    },

    'tool.execute.after': async (input) => {
      const sessionId = clean(input?.sessionID || input?.sessionId || '', 256);
      const tool = clean(input?.tool || '', 100);
      const toolId = clean(input?.callID || input?.callId || '', 256);
      if (!sessionId || BAD_IDS.has(sessionId)) return;
      writeEvent({ sessionId, event: 'PostToolUse', ...(tool ? { tool } : {}), ...(toolId ? { toolId } : {}), ...wsFields });
    },

    'permission.asked': async (perm) => {
      const sessionId = clean(perm?.sessionID || perm?.sessionId || '', 256);
      if (!sessionId || BAD_IDS.has(sessionId)) return;
      writeEvent({ sessionId, event: 'Notification', notification: 'permission_prompt', ...wsFields });
    },
  };
};

export default AgentPetPlugin;
