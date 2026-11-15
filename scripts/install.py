#!/usr/bin/env python3
"""Install this local app and observer hooks, preserving all unrelated settings."""
from pathlib import Path
import datetime
import json
import os
import plistlib
import shlex
import shutil
import sys

root = Path(__file__).resolve().parent.parent
user = Path.home()
data = user / '.dsh/companion'
backup = data / 'backups' / ('agent-pet-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
backup.mkdir(parents=True, mode=0o700)

def save_json(target, value):
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + '.agent-pet-tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temporary.chmod(0o600)
    os.replace(temporary, target)

settings = user / '.workbuddy/settings.json'
config = json.loads(settings.read_text()) if settings.exists() else {}
if settings.exists():
    shutil.copy2(settings, backup / 'workbuddy-settings.json')
hooks = config.setdefault('hooks', {})
command = shlex.quote(sys.executable) + ' ' + shlex.quote(str(root / 'connectors/workbuddy/emit.py')) + ' >/dev/null 2>&1 || true'
events = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'Notification', 'PermissionDenied']
for event in events:
    rows = hooks.setdefault(event, [])
    # Idempotent: update only this exact connector; preserve other hooks.
    for row in rows:
        row['hooks'] = [hook for hook in row.get('hooks', []) if str(root / 'connectors/workbuddy/emit.py') not in hook.get('command', '')]
    rows[:] = [row for row in rows if row.get('hooks')]
    rows.append({'matcher': '*', 'hooks': [{'type': 'command', 'command': command, 'timeout': 3}]})
save_json(settings, config)

agy_plugin = user / '.gemini/config/plugins/agent-pet'
if agy_plugin.exists():
    shutil.copytree(agy_plugin, backup / 'antigravity-plugin')
agy_plugin.mkdir(parents=True, exist_ok=True)
agy_cmd = shlex.quote(sys.executable) + ' ' + shlex.quote(str(root / 'connectors/antigravity/emit.py'))
save_json(agy_plugin / 'plugin.json', {
    'name': 'agent-pet',
    'displayName': 'Agent Pet',
    'description': 'Mirror Antigravity session lifecycle events to the local Agent Pet desktop companion (read-only observer).',
    'version': '0.2.0',
})
save_json(agy_plugin / 'hooks.json', {
    'agent-pet-observer': {
        'SessionStart': [{'type': 'command', 'command': agy_cmd, 'timeout': 3}],
        'PreInvocation': [{'type': 'command', 'command': agy_cmd, 'timeout': 3}],
        'PostToolUse': [{'matcher': '*', 'hooks': [{'type': 'command', 'command': agy_cmd, 'timeout': 3}]}],
        'PostInvocation': [{'type': 'command', 'command': agy_cmd, 'timeout': 3}],
        'Stop': [{'type': 'command', 'command': agy_cmd, 'timeout': 3}],
    },
})

codex_hooks_file = user / '.codex/hooks.json'
codex_config = json.loads(codex_hooks_file.read_text()) if codex_hooks_file.exists() else {}
if codex_hooks_file.exists():
    shutil.copy2(codex_hooks_file, backup / 'codex-hooks.json')
codex_hooks = codex_config.setdefault('hooks', {})
codex_connector = str(root / 'connectors/codex/emit.py')
codex_cmd = shlex.quote(sys.executable) + ' ' + shlex.quote(codex_connector) + ' || true'
codex_events = [('SessionStart', None), ('UserPromptSubmit', None), ('PostToolUse', '.*'), ('Stop', None)]
for event, matcher in codex_events:
    rows = codex_hooks.setdefault(event, [])
    for row in rows:
        row['hooks'] = [hook for hook in row.get('hooks', []) if codex_connector not in hook.get('command', '')]
    rows[:] = [row for row in rows if row.get('hooks')]
    entry = {'hooks': [{'type': 'command', 'command': codex_cmd, 'timeout': 3}]}
    if matcher is not None:
        entry['matcher'] = matcher
    rows.append(entry)
save_json(codex_hooks_file, codex_config)

profile = user / '.dsh/profiles/web/package.json'
if profile.exists():
    profile_config = json.loads(profile.read_text())
    shutil.copy2(profile, backup / 'dsh-profile-package.json')
    profile_config.setdefault('dependencies', {})['dsh-companion'] = 'link:' + str(root)
    bundles = profile_config.setdefault('dsh', {}).setdefault('profile', {}).setdefault('bundles', [])
    if 'dsh-companion' not in bundles:
        bundles.append('dsh-companion')
    link = profile.parent / 'node_modules/dsh-companion'
    if link.exists() and not link.is_symlink():
        raise RuntimeError('DSH companion is a real directory; not replacing it automatically')
    if link.is_symlink():
        (backup / 'dsh-plugin-link.txt').write_text(os.readlink(link))
    save_json(profile, profile_config)
    temporary = link.with_name('dsh-companion.agent-pet-tmp')
    temporary.symlink_to(root, target_is_directory=True)
    os.replace(temporary, link)

app = user / 'Applications/Agent Pet.app'
if app.exists():
    shutil.copytree(app, backup / 'Agent Pet.app')
macos = app / 'Contents/MacOS'
macos.mkdir(parents=True, exist_ok=True)
electron = user / '.dsh/electron/Electron.app/Contents/MacOS/Electron'
launcher = macos / 'AgentPet'
launcher.write_text('#!/bin/sh\nunset ELECTRON_RUN_AS_NODE\nexec ' + shlex.quote(str(electron)) + ' ' + shlex.quote(str(root / 'runtime/main.cjs')) + '\n')
launcher.chmod(0o755)
with (app / 'Contents/Info.plist').open('wb') as stream:
    plistlib.dump({'CFBundleName': 'Agent Pet', 'CFBundleDisplayName': 'Agent Pet', 'CFBundleExecutable': 'AgentPet',
                  'CFBundleIdentifier': 'io.github.chenshangyi1.agent-pet', 'CFBundleVersion': '0.2.0',
                  'CFBundlePackageType': 'APPL', 'LSUIElement': True, 'NSMicrophoneUsageDescription': '用于桌宠的 DSH 语音输入'}, stream)
print('Installed WorkBuddy observer, Antigravity plugin, Codex hooks, DSH connector and Agent Pet.app')
print('Backup:', backup)
print('WorkBuddy hooks apply to newly loaded sessions; existing sessions may need an app restart.')
print('Antigravity plugin loads automatically on new turns/sessions in ~/.gemini/config/plugins/agent-pet.')
print('Codex hooks apply to ~/.codex/hooks.json (new turns/sessions in Codex CLI & ChatGPT/Codex Desktop).')
