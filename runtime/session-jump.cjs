'use strict';

const fs = require('node:fs');
const { CATALOG_BY_ID } = require('../connectors/catalog.cjs');

const DEEP_LINK_SCHEMES = Object.freeze({
  workbuddy: 'workbuddy',
  'workbuddy-ai': 'workbuddy-ai',
});

const WORKSPACE_ARG_PROVIDERS = new Set([
  'antigravity',
  'cursor',
  'kiro',
  'trae',
  'trae-cn',
  'qoder',
  'qoder-cn',
  'windsurf',
  'zcode',
  'opencode',
]);

function defaultIsDirectory(targetPath) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) return false;
  try {
    return fs.statSync(targetPath.trim()).isDirectory();
  } catch {
    return false;
  }
}

function extractRawSessionId(sessionId, provider) {
  if (typeof sessionId !== 'string' || !sessionId) return '';
  const prefix = provider ? `${provider}:` : '';
  if (prefix && sessionId.startsWith(prefix)) {
    return sessionId.slice(prefix.length);
  }
  const idx = sessionId.indexOf(':');
  return idx > 0 ? sessionId.slice(idx + 1) : sessionId;
}

/**
 * Compute an ordered jump plan so clicking a notification card lands directly
 * on the matching conversation or project workspace instead of only raising a generic home window.
 */
function buildJumpPlan(item = {}, { entry = null, isDirectory = defaultIsDirectory } = {}) {
  const provider = String(item.provider || '').trim()
    || (typeof item.sessionId === 'string' && item.sessionId.includes(':')
      ? item.sessionId.split(':')[0]
      : '');
  const catalogEntry = entry || CATALOG_BY_ID[provider] || null;
  const rawSessionId = extractRawSessionId(item.sessionId || '', provider);
  const workspacePath = typeof item.workspacePath === 'string' && isDirectory(item.workspacePath)
    ? item.workspacePath.trim()
    : '';
  const steps = [];

  if (provider === 'dsh') {
    steps.push({ kind: 'dsh', sessionId: rawSessionId || item.sessionId || '' });
    return { provider, rawSessionId, workspacePath, steps };
  }

  const scheme = DEEP_LINK_SCHEMES[provider];
  if (scheme && rawSessionId && /^[A-Za-z0-9_.-]+$/.test(rawSessionId)) {
    steps.push({ kind: 'url', url: `${scheme}://chat/${encodeURIComponent(rawSessionId)}` });
  }

  if (catalogEntry?.bundleId) {
    if (workspacePath && WORKSPACE_ARG_PROVIDERS.has(provider)) {
      steps.push({ kind: 'bundle', bundleId: catalogEntry.bundleId, targetPath: workspacePath });
    }
    steps.push({ kind: 'bundle', bundleId: catalogEntry.bundleId });
  }

  if (workspacePath) {
    steps.push({ kind: 'path', targetPath: workspacePath });
  }

  return { provider, rawSessionId, workspacePath, steps };
}

/** Execute the jump plan in priority order with clean fallbacks. */
async function jumpToSession(item = {}, {
  entry = null,
  isDirectory = defaultIsDirectory,
  openDsh,
  openExternal,
  openBundle,
  openPath,
} = {}) {
  const plan = buildJumpPlan(item, { entry, isDirectory });
  const label = (entry || CATALOG_BY_ID[plan.provider])?.label || plan.provider || '目标应用';
  let lastError = null;

  for (const step of plan.steps) {
    try {
      if (step.kind === 'dsh' && typeof openDsh === 'function') {
        await openDsh(step.sessionId);
        return { opened: true, method: 'dsh', provider: plan.provider };
      }
      if (step.kind === 'url' && typeof openExternal === 'function') {
        await openExternal(step.url);
        return { opened: true, method: 'url', url: step.url, provider: plan.provider };
      }
      if (step.kind === 'bundle' && typeof openBundle === 'function') {
        await openBundle(step.bundleId, step.targetPath);
        return { opened: true, method: step.targetPath ? 'bundle+workspace' : 'bundle', provider: plan.provider };
      }
      if (step.kind === 'path' && typeof openPath === 'function') {
        await openPath(step.targetPath);
        return { opened: true, method: 'path', targetPath: step.targetPath, provider: plan.provider };
      }
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error(`无法打开 ${label}`);
}

module.exports = {
  WORKSPACE_ARG_PROVIDERS,
  buildJumpPlan,
  jumpToSession,
};
