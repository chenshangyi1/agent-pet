'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CONNECTOR_CATALOG, CATALOG_BY_ID, DEFAULT_ENABLED_IDS } = require('./catalog.cjs');

const EMITTER_MARKERS = [
  'connectors/hooks/emit.py',
  'connectors/workbuddy/emit.py',
  'connectors/antigravity/emit.py',
  'connectors/codex/emit.py',
];

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function nowStamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function writeAtomic(filePath, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.agent-pet-${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, filePath);
}

function writeJsonAtomic(filePath, data, mode = 0o600) {
  writeAtomic(filePath, JSON.stringify(data, null, 2) + '\n', mode);
}

function readJsonStrict(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return fallback;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`配置文件格式无效: ${filePath}`);
  }
  return parsed;
}

function containsPetMarker(text) {
  return typeof text === 'string' && EMITTER_MARKERS.some(marker => text.includes(marker));
}

function filterHookEntries(entries) {
  if (!Array.isArray(entries)) return [];
  const next = [];
  for (const row of entries) {
    if (!row || typeof row !== 'object') continue;
    if (Array.isArray(row.hooks)) {
      const remaining = row.hooks.filter(h => !containsPetMarker(h?.command));
      if (remaining.length > 0) next.push({ ...row, hooks: remaining });
    } else if (!containsPetMarker(row.command)) {
      next.push(row);
    }
  }
  return next;
}

const STANDARD_NESTED_EVENTS = [
  { name: 'SessionStart' },
  { name: 'SessionEnd' },
  { name: 'UserPromptSubmit' },
  { name: 'PreToolUse', matcher: '.*' },
  { name: 'PostToolUse', matcher: '.*' },
  { name: 'PostToolUseFailure', matcher: '.*' },
  { name: 'Notification', matcher: '.*' },
  { name: 'PermissionDenied', matcher: '.*' },
  { name: 'Stop' },
  { name: 'StopFailure' },
];

const HOOK_TARGETS = {
  claude: {
    kind: 'nested-hooks',
    relPath: '.claude/settings.json',
    events: STANDARD_NESTED_EVENTS,
  },
  workbuddy: {
    kind: 'nested-hooks',
    relPath: '.workbuddy/settings.json',
    events: [
      { name: 'SessionStart' },
      { name: 'SessionEnd' },
      { name: 'UserPromptSubmit' },
      { name: 'PreToolUse', matcher: '*' },
      { name: 'PostToolUse', matcher: '*' },
      { name: 'PostToolUseFailure', matcher: '*' },
      { name: 'Notification', matcher: '*' },
      { name: 'PermissionDenied', matcher: '*' },
      { name: 'Stop' },
      { name: 'StopFailure' },
    ],
  },
  'workbuddy-ai': {
    kind: 'nested-hooks',
    relPath: '.workbuddy-ai/settings.json',
    events: STANDARD_NESTED_EVENTS,
  },
  'qoder-cn': {
    kind: 'nested-hooks',
    relPath: '.qoder-cn/settings.json',
    events: STANDARD_NESTED_EVENTS.filter(spec => spec.name !== 'Notification'),
  },
  qoder: {
    kind: 'nested-hooks',
    relPath: '.qoder/settings.json',
    events: STANDARD_NESTED_EVENTS,
  },
  codebuddy: {
    kind: 'nested-hooks',
    relPath: '.codebuddy/settings.json',
    events: STANDARD_NESTED_EVENTS,
  },
  'codebuddy-cn': {
    kind: 'nested-hooks',
    relPath: '.codebuddycn/settings.json',
    events: STANDARD_NESTED_EVENTS,
  },
  'qwen-code': {
    kind: 'nested-hooks',
    relPath: '.qwen/settings.json',
    events: STANDARD_NESTED_EVENTS,
  },
  droid: {
    kind: 'nested-hooks',
    relPath: '.factory/settings.json',
    events: STANDARD_NESTED_EVENTS,
  },
  'gemini-cli': {
    kind: 'nested-hooks',
    relPath: '.gemini/settings.json',
    format: 'gemini',
    events: [
      { name: 'SessionStart', matcher: 'startup' },
      { name: 'BeforeAgent', matcher: '*' },
      { name: 'AfterAgent', matcher: '*' },
      { name: 'BeforeTool', matcher: '*' },
      { name: 'AfterTool', matcher: '*' },
      { name: 'Notification', matcher: '*' },
      { name: 'SessionEnd', matcher: '*' },
    ],
  },
  windsurf: {
    kind: 'windsurf-hooks',
    relPath: '.codeium/windsurf/hooks.json',
    format: 'windsurf',
    events: [
      { name: 'pre_user_prompt' },
      { name: 'pre_read_code' },
      { name: 'post_read_code' },
      { name: 'pre_write_code' },
      { name: 'post_write_code' },
      { name: 'pre_run_command' },
      { name: 'post_run_command' },
      { name: 'post_cascade_response' },
    ],
  },
  codex: {
    kind: 'nested-hooks',
    relPath: '.codex/hooks.json',
    events: [
      { name: 'SessionStart' },
      { name: 'UserPromptSubmit' },
      { name: 'PostToolUse', matcher: '.*' },
      { name: 'Stop' },
    ],
  },
  trae: {
    kind: 'nested-hooks',
    relPath: '.trae/hooks.json',
    events: [
      { name: 'SessionStart' },
      { name: 'UserPromptSubmit' },
      { name: 'PreToolUse', matcher: '.*' },
      { name: 'PostToolUse', matcher: '.*' },
      { name: 'Notification' },
      { name: 'Stop' },
    ],
  },
  'trae-cn': {
    kind: 'nested-hooks',
    relPath: '.trae-cn/hooks.json',
    events: [
      { name: 'SessionStart' },
      { name: 'UserPromptSubmit' },
      { name: 'PreToolUse', matcher: '.*' },
      { name: 'PostToolUse', matcher: '.*' },
      { name: 'Notification' },
      { name: 'Stop' },
    ],
  },
  cursor: {
    kind: 'cursor-hooks',
    relPath: '.cursor/hooks.json',
    format: 'cursor',
    events: [
      { name: 'sessionStart' },
      { name: 'beforeSubmitPrompt' },
      { name: 'preToolUse', matcher: '.*' },
      { name: 'postToolUse', matcher: '.*' },
      { name: 'postToolUseFailure', matcher: '.*' },
      { name: 'stop' },
    ],
  },
};

class ConnectorRegistry {
  constructor(options = {}) {
    this.rootDir = options.rootDir || path.resolve(__dirname, '..');
    this.homeDir = options.homeDir || os.homedir();
    this.dataDir = options.dataDir || path.join(this.homeDir, '.dsh', 'companion');
    this.appsDirs = options.appsDirs || ['/Applications', path.join(this.homeDir, 'Applications')];
    this.pathDirs = options.pathDirs || (process.env.PATH ? process.env.PATH.split(path.delimiter) : []);
    this._explicitPythonPath = String(options.pythonPath || process.env.AGENT_PET_PYTHON || '').trim();
    this.pythonPath = this._explicitPythonPath || this.resolvePython();
    this.stateFile = path.join(this.dataDir, 'connectors.json');
  }

  resolvePython() {
    if (this._explicitPythonPath) return this._explicitPythonPath;
    for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
      const candidate = path.join(dir, 'python3');
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
    return 'python3';
  }

  emitPyPath() {
    return path.join(this.rootDir, 'connectors', 'hooks', 'emit.py');
  }

  readEnabledSet() {
    const enabled = new Set(DEFAULT_ENABLED_IDS);
    try {
      if (fs.existsSync(this.stateFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        if (Array.isArray(parsed?.enabled)) {
          for (const id of parsed.enabled) {
            if (CATALOG_BY_ID[id]) enabled.add(id);
          }
        }
      }
    } catch {
      // Corrupt state falls back cleanly to default DSH only.
    }
    return enabled;
  }

  saveEnabledSet(enabledSet) {
    const ordered = CONNECTOR_CATALOG
      .map(item => item.id)
      .filter(id => CATALOG_BY_ID[id].defaultEnabled || enabledSet.has(id));
    writeJsonAtomic(this.stateFile, { v: 1, enabled: ordered });
    return ordered;
  }

  enabledIds() {
    const enabled = this.readEnabledSet();
    return CONNECTOR_CATALOG
      .map(item => item.id)
      .filter(id => CATALOG_BY_ID[id].defaultEnabled || enabled.has(id));
  }

  detectInstallPaths(entry) {
    const found = [];
    for (const appName of entry.appNames || []) {
      for (const base of this.appsDirs) {
        const candidate = path.join(base, appName);
        if (fs.existsSync(candidate)) found.push(candidate);
      }
    }
    for (const rel of entry.cliPaths || []) {
      const candidate = path.join(this.homeDir, rel);
      if (fs.existsSync(candidate)) found.push(candidate);
    }
    for (const bin of entry.cliNames || []) {
      for (const dir of this.pathDirs) {
        if (!dir) continue;
        const candidate = path.join(dir, bin);
        if (fs.existsSync(candidate)) {
          found.push(candidate);
          break;
        }
      }
    }
    for (const rel of entry.configDirs || []) {
      const candidate = path.join(this.homeDir, rel);
      if (fs.existsSync(candidate)) found.push(candidate);
    }
    if (Array.isArray(entry.vscodeExtensions) && entry.vscodeExtensions.length) {
      const extDir = path.join(this.homeDir, '.vscode', 'extensions');
      try {
        if (fs.existsSync(extDir)) {
          for (const name of fs.readdirSync(extDir)) {
            if (entry.vscodeExtensions.some(prefix => name.startsWith(prefix))) {
              found.push(path.join(extDir, name));
            }
          }
        }
      } catch {}
    }
    return [...new Set(found)];
  }

  clineHookDirs() {
    return [
      path.join(this.homeDir, '.cline', 'hooks'),
      path.join(this.homeDir, 'Documents', 'Cline', 'Rules', 'Hooks'),
    ];
  }

  isHookConfigured(id) {
    if (id === 'dsh') return fs.existsSync(path.join(this.homeDir, '.dsh/profiles/web/node_modules/dsh-companion'));
    if (id === 'opencode') return fs.existsSync(path.join(this.homeDir, '.config/opencode/plugins/agent-pet.js'));
    if (id === 'antigravity') return fs.existsSync(path.join(this.homeDir, '.gemini/config/plugins/agent-pet/hooks.json'));
    if (id === 'zcode') return fs.existsSync(path.join(this.homeDir, '.zcode/cli/plugins/agent-pet/hooks/hooks.json'));
    if (id === 'kiro') return fs.existsSync(path.join(this.homeDir, '.kiro/hooks/agent-pet.json'));
    if (id === 'copilot') return fs.existsSync(path.join(this.homeDir, '.copilot/hooks/agent-pet.json'));
    if (id === 'cline') {
      return this.clineHookDirs().some(dir => {
        const probe = path.join(dir, 'PreToolUse');
        try { return fs.existsSync(probe) && fs.readFileSync(probe, 'utf8').includes('# agent-pet-hook'); }
        catch { return false; }
      });
    }
    const target = HOOK_TARGETS[id];
    if (!target) return false;
    const file = path.join(this.homeDir, target.relPath);
    if (!fs.existsSync(file)) return false;
    try {
      const text = fs.readFileSync(file, 'utf8');
      const hasUnified = text.includes('connectors/hooks/emit.py') && text.includes(`--provider ${id}`);
      const hasLegacy = text.includes(`connectors/${id}/emit.py`);
      return hasUnified || hasLegacy;
    } catch {
      return false;
    }
  }

  backupTarget(action, id, targetPath) {
    if (!fs.existsSync(targetPath)) return null;
    const backupDir = path.join(this.dataDir, 'backups', `connector-${action}-${id}-${nowStamp()}`);
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const dest = path.join(backupDir, path.basename(targetPath));
    fs.cpSync(targetPath, dest, { recursive: true });
    return backupDir;
  }

  installHooksTarget(id, target) {
    const filePath = path.join(this.homeDir, target.relPath);
    const config = readJsonStrict(filePath, {});
    this.backupTarget('enable', id, filePath);

    if (target.kind === 'cursor-hooks' || target.kind === 'windsurf-hooks') {
      if (target.kind === 'cursor-hooks' && config.version === undefined) config.version = 1;
      const hooks = (config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks)) ? { ...config.hooks } : {};
      const cmd = `${shQuote(this.resolvePython())} ${shQuote(this.emitPyPath())} --provider ${id} --format ${target.format || 'standard'} >/dev/null 2>&1 || true`;
      for (const spec of target.events) {
        const cleaned = filterHookEntries(hooks[spec.name]);
        const entry = target.kind === 'windsurf-hooks'
          ? { command: cmd, show_output: false }
          : { command: cmd, timeout: 3 };
        if (spec.matcher) entry.matcher = spec.matcher;
        cleaned.push(entry);
        hooks[spec.name] = cleaned;
      }
      config.hooks = hooks;
    } else {
      const hooks = (config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks)) ? { ...config.hooks } : {};
      const cmd = `${shQuote(this.resolvePython())} ${shQuote(this.emitPyPath())} --provider ${id} --format ${target.format || 'standard'} >/dev/null 2>&1 || true`;
      for (const spec of target.events) {
        const cleaned = filterHookEntries(hooks[spec.name]);
        const entry = { hooks: [{ type: 'command', command: cmd, timeout: 3 }] };
        if (spec.matcher) entry.matcher = spec.matcher;
        cleaned.push(entry);
        hooks[spec.name] = cleaned;
      }
      config.hooks = hooks;
    }
    writeJsonAtomic(filePath, config);
  }

  uninstallHooksTarget(id, target) {
    const filePath = path.join(this.homeDir, target.relPath);
    if (!fs.existsSync(filePath)) return;
    const config = readJsonStrict(filePath, {});
    if (!config.hooks || typeof config.hooks !== 'object') return;
    this.backupTarget('disable', id, filePath);
    const hooks = { ...config.hooks };
    for (const eventName of Object.keys(hooks)) {
      const remaining = filterHookEntries(hooks[eventName]);
      if (remaining.length > 0) hooks[eventName] = remaining;
      else delete hooks[eventName];
    }
    if (Object.keys(hooks).length > 0) config.hooks = hooks;
    else delete config.hooks;
    writeJsonAtomic(filePath, config);
  }

  installKiro() {
    const filePath = path.join(this.homeDir, '.kiro/hooks/agent-pet.json');
    this.backupTarget('enable', 'kiro', filePath);
    const python = shQuote(this.resolvePython());
    const emitPy = shQuote(this.emitPyPath());
    const specs = [
      { name: 'Agent Pet Session Start', trigger: 'SessionStart' },
      { name: 'Agent Pet Prompt Submit', trigger: 'UserPromptSubmit' },
      { name: 'Agent Pet Post Tool Use', trigger: 'PostToolUse', matcher: '.*' },
      { name: 'Agent Pet Stop', trigger: 'Stop' },
    ];
    writeJsonAtomic(filePath, {
      version: 'v1',
      hooks: specs.map(spec => ({
        name: spec.name,
        description: 'Mirror sanitized Kiro session lifecycle events to Agent Pet.',
        enabled: true,
        trigger: spec.trigger,
        ...(spec.matcher ? { matcher: spec.matcher } : {}),
        action: {
          type: 'command',
          command: `${python} ${emitPy} --provider kiro --format kiro --event ${spec.trigger} >/dev/null 2>&1 || true`,
        },
      })),
    });
  }

  uninstallKiro() {
    const filePath = path.join(this.homeDir, '.kiro/hooks/agent-pet.json');
    if (!fs.existsSync(filePath)) return;
    this.backupTarget('disable', 'kiro', filePath);
    fs.rmSync(filePath, { force: true });
  }

  installAntigravity() {
    const pluginDir = path.join(this.homeDir, '.gemini/config/plugins/agent-pet');
    this.backupTarget('enable', 'antigravity', pluginDir);
    const cmd = `${shQuote(this.resolvePython())} ${shQuote(this.emitPyPath())} --provider antigravity --format antigravity`;
    writeJsonAtomic(path.join(pluginDir, 'plugin.json'), {
      name: 'agent-pet',
      displayName: 'Agent Pet',
      description: 'Mirror Antigravity session lifecycle events to Agent Pet (read-only observer).',
      version: '0.3.0',
    });
    writeJsonAtomic(path.join(pluginDir, 'hooks.json'), {
      'agent-pet-observer': {
        SessionStart: [{ type: 'command', command: cmd, timeout: 3 }],
        PreInvocation: [{ type: 'command', command: cmd, timeout: 3 }],
        PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: cmd, timeout: 3 }] }],
        PostToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: cmd, timeout: 3 }] }],
        PostInvocation: [{ type: 'command', command: cmd, timeout: 3 }],
        Stop: [{ type: 'command', command: cmd, timeout: 3 }],
        StopFailure: [{ type: 'command', command: cmd, timeout: 3 }],
      },
    });
  }

  uninstallAntigravity() {
    const pluginDir = path.join(this.homeDir, '.gemini/config/plugins/agent-pet');
    if (!fs.existsSync(pluginDir)) return;
    this.backupTarget('disable', 'antigravity', pluginDir);
    fs.rmSync(pluginDir, { recursive: true, force: true });
  }

  installOpenCode() {
    const target = path.join(this.homeDir, '.config/opencode/plugins/agent-pet.js');
    this.backupTarget('enable', 'opencode', target);
    const src = path.join(this.rootDir, 'connectors/opencode/agent-pet.js');
    writeAtomic(target, fs.readFileSync(src, 'utf8'), 0o600);
  }

  uninstallOpenCode() {
    const target = path.join(this.homeDir, '.config/opencode/plugins/agent-pet.js');
    if (!fs.existsSync(target)) return;
    this.backupTarget('disable', 'opencode', target);
    fs.rmSync(target, { force: true });
  }

  installCopilot() {
    const filePath = path.join(this.homeDir, '.copilot/hooks/agent-pet.json');
    this.backupTarget('enable', 'copilot', filePath);
    const cmd = `${shQuote(this.resolvePython())} ${shQuote(this.emitPyPath())} --provider copilot --format copilot`;
    const events = ['sessionStart', 'userPromptSubmitted', 'preToolUse', 'postToolUse', 'errorOccurred', 'sessionEnd'];
    const hooks = {};
    for (const ev of events) {
      hooks[ev] = [{
        type: 'command',
        bash: `${cmd} --event ${ev} >/dev/null 2>&1 || true`,
        timeoutSec: 5,
      }];
    }
    writeJsonAtomic(filePath, { version: 1, hooks });
  }

  uninstallCopilot() {
    const filePath = path.join(this.homeDir, '.copilot/hooks/agent-pet.json');
    if (!fs.existsSync(filePath)) return;
    this.backupTarget('disable', 'copilot', filePath);
    fs.rmSync(filePath, { force: true });
  }

  installCline() {
    const python = shQuote(this.resolvePython());
    const emitPy = shQuote(this.emitPyPath());
    const hookNames = ['TaskStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'TaskComplete', 'TaskCancel'];
    for (const dir of this.clineHookDirs()) {
      for (const name of hookNames) {
        const filePath = path.join(dir, name);
        if (fs.existsSync(filePath)) {
          const existing = fs.readFileSync(filePath, 'utf8');
          if (!existing.includes('# agent-pet-hook')) continue;
        }
        const script = [
          '#!/bin/sh',
          '# agent-pet-hook',
          `${python} ${emitPy} --provider cline --format cline --event ${name} || echo '{"cancel":false}'`,
          '',
        ].join('\n');
        writeAtomic(filePath, script, 0o700);
      }
    }
  }

  uninstallCline() {
    const hookNames = ['TaskStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'TaskComplete', 'TaskCancel'];
    for (const dir of this.clineHookDirs()) {
      for (const name of hookNames) {
        const filePath = path.join(dir, name);
        if (!fs.existsSync(filePath)) continue;
        try {
          if (!fs.readFileSync(filePath, 'utf8').includes('# agent-pet-hook')) continue;
        } catch { continue; }
        this.backupTarget('disable', 'cline', filePath);
        fs.rmSync(filePath, { force: true });
      }
    }
  }

  installZCode() {
    const pluginId = 'agent-pet@agent-pet-local';
    const pluginDir = path.join(this.homeDir, '.zcode/cli/plugins/agent-pet');
    const pluginsJson = path.join(this.homeDir, '.zcode/cli/plugins/installed_plugins.json');
    const cliConfigJson = path.join(this.homeDir, '.zcode/cli/config.json');
    this.backupTarget('enable', 'zcode', pluginDir);
    if (fs.existsSync(pluginsJson)) this.backupTarget('enable', 'zcode', pluginsJson);
    if (fs.existsSync(cliConfigJson)) this.backupTarget('enable', 'zcode', cliConfigJson);

    const cmd = `${shQuote(this.resolvePython())} ${shQuote(this.emitPyPath())} --provider zcode --format standard >/dev/null 2>&1 || true`;
    const manifest = {
      name: 'agent-pet',
      version: '0.3.0',
      description: 'Mirror ZCode lifecycle events to Agent Pet (read-only observer).',
      author: { name: 'Agent Pet' },
    };
    writeJsonAtomic(path.join(pluginDir, '.zcode-plugin/plugin.json'), manifest);
    writeJsonAtomic(path.join(pluginDir, '.claude-plugin/plugin.json'), manifest);
    const hookBlock = eventMatcher => [{
      ...(eventMatcher ? { matcher: eventMatcher } : {}),
      hooks: [{ type: 'command', command: cmd, timeout: 3 }],
    }];
    writeJsonAtomic(path.join(pluginDir, 'hooks/hooks.json'), {
      hooks: {
        SessionStart: hookBlock('startup|clear|compact'),
        UserPromptSubmit: hookBlock(),
        PreToolUse: hookBlock('.*'),
        PostToolUse: hookBlock('.*'),
        PostToolUseFailure: hookBlock('.*'),
        Stop: hookBlock(),
        SessionEnd: hookBlock(),
      },
    });

    const installed = readJsonStrict(pluginsJson, { version: 1, plugins: [] });
    const list = Array.isArray(installed.plugins) ? installed.plugins.filter(p => p?.id !== pluginId) : [];
    const now = new Date().toISOString();
    list.push({
      id: pluginId,
      name: 'agent-pet',
      marketplace: 'agent-pet-local',
      version: '0.3.0',
      installPath: pluginDir,
      installedAt: now,
      updatedAt: now,
      scope: 'user',
    });
    writeJsonAtomic(pluginsJson, { version: installed.version ?? 1, plugins: list });

    const cliConfig = readJsonStrict(cliConfigJson, {});
    const pluginsSection = (cliConfig.plugins && typeof cliConfig.plugins === 'object' && !Array.isArray(cliConfig.plugins))
      ? { ...cliConfig.plugins }
      : {};
    const enabledMap = (pluginsSection.enabledPlugins && typeof pluginsSection.enabledPlugins === 'object' && !Array.isArray(pluginsSection.enabledPlugins))
      ? { ...pluginsSection.enabledPlugins }
      : {};
    enabledMap[pluginId] = true;
    pluginsSection.enabledPlugins = enabledMap;
    cliConfig.plugins = pluginsSection;
    writeJsonAtomic(cliConfigJson, cliConfig);
  }

  uninstallZCode() {
    const pluginId = 'agent-pet@agent-pet-local';
    const pluginDir = path.join(this.homeDir, '.zcode/cli/plugins/agent-pet');
    const pluginsJson = path.join(this.homeDir, '.zcode/cli/plugins/installed_plugins.json');
    const cliConfigJson = path.join(this.homeDir, '.zcode/cli/config.json');
    if (fs.existsSync(pluginDir)) {
      this.backupTarget('disable', 'zcode', pluginDir);
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }
    if (fs.existsSync(pluginsJson)) {
      const installed = readJsonStrict(pluginsJson, { version: 1, plugins: [] });
      if (Array.isArray(installed.plugins)) {
        const next = installed.plugins.filter(p => p?.id !== pluginId);
        if (next.length !== installed.plugins.length) {
          this.backupTarget('disable', 'zcode', pluginsJson);
          writeJsonAtomic(pluginsJson, { ...installed, plugins: next });
        }
      }
    }
    if (fs.existsSync(cliConfigJson)) {
      const cliConfig = readJsonStrict(cliConfigJson, {});
      if (cliConfig.plugins?.enabledPlugins && Object.hasOwn(cliConfig.plugins.enabledPlugins, pluginId)) {
        this.backupTarget('disable', 'zcode', cliConfigJson);
        delete cliConfig.plugins.enabledPlugins[pluginId];
        writeJsonAtomic(cliConfigJson, cliConfig);
      }
    }
  }

  installDshBridge() {
    const profilePath = path.join(this.homeDir, '.dsh/profiles/web/package.json');
    if (!fs.existsSync(profilePath)) return false;
    const profile = readJsonStrict(profilePath, {});
    this.backupTarget('enable', 'dsh', profilePath);
    profile.dependencies = { ...(profile.dependencies || {}), 'dsh-companion': `link:${this.rootDir}` };
    profile.dsh = profile.dsh || {};
    profile.dsh.profile = profile.dsh.profile || {};
    const bundles = Array.isArray(profile.dsh.profile.bundles) ? [...profile.dsh.profile.bundles] : [];
    if (!bundles.includes('dsh-companion')) bundles.push('dsh-companion');
    profile.dsh.profile.bundles = bundles;
    const link = path.join(path.dirname(profilePath), 'node_modules', 'dsh-companion');
    if (fs.existsSync(link) && !fs.lstatSync(link).isSymbolicLink()) {
      throw new Error('dsh-companion 目录不是符号链接，无法自动覆盖');
    }
    writeJsonAtomic(profilePath, profile);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    const tmpLink = path.join(path.dirname(link), `.dsh-companion-${process.pid}.tmp`);
    fs.rmSync(tmpLink, { force: true });
    fs.symlinkSync(this.rootDir, tmpLink, 'dir');
    fs.renameSync(tmpLink, link);
    return true;
  }

  enable(id) {
    const entry = CATALOG_BY_ID[id];
    if (!entry) throw new Error(`未知的连接器: ${id}`);
    if (id === 'dsh') this.installDshBridge();
    else if (id === 'kiro') this.installKiro();
    else if (id === 'antigravity') this.installAntigravity();
    else if (id === 'opencode') this.installOpenCode();
    else if (id === 'copilot') this.installCopilot();
    else if (id === 'cline') this.installCline();
    else if (id === 'zcode') this.installZCode();
    else if (HOOK_TARGETS[id]) this.installHooksTarget(id, HOOK_TARGETS[id]);
    else throw new Error(`暂不支持自动配置: ${entry.label}`);

    const enabled = this.readEnabledSet();
    enabled.add(id);
    this.saveEnabledSet(enabled);
    return this.detectAll();
  }

  enableAllInstalled() {
    for (const item of this.detectAll()) {
      if (item.installed && (item.id !== 'dsh' || !item.hookConfigured)) {
        this.enable(item.id);
      }
    }
    if (!fs.existsSync(this.stateFile)) {
      this.saveEnabledSet(this.readEnabledSet());
    }
    return this.detectAll();
  }

  disable(id) {
    const entry = CATALOG_BY_ID[id];
    if (!entry) throw new Error(`未知的连接器: ${id}`);
    if (!entry.toggleable) throw new Error(`${entry.label} 为默认核心连接，不可关闭`);

    if (id === 'kiro') this.uninstallKiro();
    else if (id === 'antigravity') this.uninstallAntigravity();
    else if (id === 'opencode') this.uninstallOpenCode();
    else if (id === 'copilot') this.uninstallCopilot();
    else if (id === 'cline') this.uninstallCline();
    else if (id === 'zcode') this.uninstallZCode();
    else if (HOOK_TARGETS[id]) this.uninstallHooksTarget(id, HOOK_TARGETS[id]);

    const enabled = this.readEnabledSet();
    enabled.delete(id);
    this.saveEnabledSet(enabled);
    return this.detectAll();
  }

  detectAll() {
    const enabled = this.readEnabledSet();
    return CONNECTOR_CATALOG.map(entry => {
      const detectedPaths = this.detectInstallPaths(entry);
      const installed = detectedPaths.length > 0;
      const isEnabled = Boolean(entry.defaultEnabled) || enabled.has(entry.id);
      const hookConfigured = this.isHookConfigured(entry.id);
      return {
        id: entry.id,
        label: entry.label,
        kind: entry.kind,
        mechanism: entry.mechanism,
        defaultEnabled: Boolean(entry.defaultEnabled),
        toggleable: Boolean(entry.toggleable),
        replySupported: Boolean(entry.replySupported),
        bundleId: entry.bundleId,
        installed,
        enabled: isEnabled,
        hookConfigured,
        detectedPaths,
        canLaunch: Boolean(entry.bundleId && detectedPaths.some(p => p.endsWith('.app'))) || entry.id === 'dsh',
      };
    });
  }
}

module.exports = { ConnectorRegistry };
