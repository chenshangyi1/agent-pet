#!/usr/bin/env python3
"""Install Agent Pet app cleanly in standalone mode (and optional DSH bridge when present)."""
import argparse
from pathlib import Path
import datetime
import json
import os
import plistlib
import shlex
import shutil
import subprocess

root = Path(__file__).resolve().parent.parent
user = Path.home()
data = Path(os.environ.get('AGENT_PET_DATA') or os.environ.get('DSH_COMPANION_DATA') or (user / '.dsh/companion'))
backup = data / 'backups' / ('agent-pet-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
backup.mkdir(parents=True, mode=0o700, exist_ok=True)


def save_json(target, value):
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + '.agent-pet-tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temporary.chmod(0o600)
    os.replace(temporary, target)


def resolve_electron():
    override = os.environ.get('AGENT_PET_ELECTRON', '').strip()
    if override:
        override_path = Path(override).expanduser()
        if override_path.is_file():
            return override_path
        found = shutil.which(override)
        if found:
            return Path(found)

    which_electron = shutil.which('electron')
    candidates = [
        root / 'node_modules/.bin/electron',
        root / 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
        Path('/Applications/Electron.app/Contents/MacOS/Electron'),
        Path(which_electron) if which_electron else None,
        user / '.dsh/electron/Electron.app/Contents/MacOS/Electron',
    ]
    for candidate in candidates:
        if candidate and candidate.is_file():
            return candidate
    return None


def install_dsh_profile():
    profile = user / '.dsh/profiles/web/package.json'
    if not profile.exists():
        return False
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
    return True


def install_app():
    app = user / 'Applications/Agent Pet.app'
    if app.exists():
        shutil.copytree(app, backup / 'Agent Pet.app', symlinks=True)
    macos = app / 'Contents/MacOS'
    macos.mkdir(parents=True, exist_ok=True)
    electron = resolve_electron()
    launcher = macos / 'AgentPet'
    main_script = shlex.quote(str(root / 'runtime/main.cjs'))
    if electron is not None:
        launcher.write_text(
            '#!/bin/sh\n'
            'unset ELECTRON_RUN_AS_NODE\n'
            f'exec {shlex.quote(str(electron))} {main_script}\n'
        )
    else:
        fallback_lines = [
            '#!/bin/sh',
            'unset ELECTRON_RUN_AS_NODE',
            'for bin in \\',
            '  "$AGENT_PET_ELECTRON" \\',
            f'  {shlex.quote(str(root / "node_modules/.bin/electron"))} \\',
            f'  {shlex.quote(str(root / "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"))} \\',
            '  "/Applications/Electron.app/Contents/MacOS/Electron" \\',
            '  "$(command -v electron 2>/dev/null)" \\',
            '  "$HOME/.dsh/electron/Electron.app/Contents/MacOS/Electron"; do',
            '  if [ -n "$bin" ] && [ -x "$bin" ]; then',
            f'    exec "$bin" {main_script}',
            '  fi',
            'done',
            'echo "Agent Pet: Electron runtime not found. Set AGENT_PET_ELECTRON or install Electron." >&2',
            'exit 1',
            '',
        ]
        launcher.write_text('\n'.join(fallback_lines))
    launcher.chmod(0o755)
    with (app / 'Contents/Info.plist').open('wb') as stream:
        plistlib.dump({
            'CFBundleName': 'Agent Pet',
            'CFBundleDisplayName': 'Agent Pet',
            'CFBundleExecutable': 'AgentPet',
            'CFBundleIdentifier': 'local.chenmingxin.agent-pet',
            'CFBundleVersion': '0.3.0',
            'CFBundlePackageType': 'APPL',
            'LSUIElement': True,
            'NSMicrophoneUsageDescription': '用于桌宠小鑫的语音输入',
            'NSSpeechRecognitionUsageDescription': '用于桌宠小鑫识别你的语音并与 AI 对话',
        }, stream)
    return electron


def enable_connectors(targets):
    node = shutil.which('node')
    if not node:
        raise RuntimeError('node is required to enable extra connectors')
    script = (
        "const { ConnectorRegistry } = require('./connectors/registry.cjs');"
        "const reg = new ConnectorRegistry({ rootDir: process.cwd(), dataDir: process.env.AGENT_PET_DATA });"
        "const targets = JSON.parse(process.argv[1]);"
        "const items = reg.detectAll();"
        "const ids = targets === 'ALL' ? items.filter(i => i.installed && i.id !== 'dsh').map(i => i.id) : targets;"
        "for (const id of ids) reg.enable(id);"
        "console.log(JSON.stringify(ids));"
    )
    env = dict(os.environ, AGENT_PET_DATA=str(data))
    res = subprocess.run([node, '-e', script, json.dumps(targets)], cwd=root, env=env, capture_output=True, text=True, check=True)
    return json.loads(res.stdout.strip() or '[]')


def main():
    parser = argparse.ArgumentParser(description='Install Agent Pet (小鑫)')
    parser.add_argument('--all', action='store_true', help='Auto-enable all locally detected AI Agents')
    parser.add_argument('--enable', default='', help='Comma-separated connector ids to enable besides dsh')
    args = parser.parse_args()

    dsh_ok = install_dsh_profile()
    connectors_file = data / 'connectors.json'
    if not connectors_file.exists():
        save_json(connectors_file, {'v': 1, 'enabled': ['dsh']})

    electron = install_app()

    extra = []
    if args.all:
        extra = enable_connectors('ALL')
    elif args.enable.strip():
        extra = enable_connectors([part.strip() for part in args.enable.split(',') if part.strip()])

    if dsh_ok:
        print('Installed Agent Pet.app + DSH bridge')
    else:
        print('Installed Agent Pet.app (standalone mode — DSH not detected, running independently)')
    print('Electron runtime:', str(electron) if electron else 'not found at install time (launcher will search at runtime; set AGENT_PET_ELECTRON or install Electron)')
    print('Enabled connectors: dsh' + (f", {', '.join(extra)}" if extra else ''))
    print('Open Manager (+ in NotchPanel or tray -> 管理 AI Agent... / Bot 派活与通知...) or run `npm run bot` for headless gateway.')
    print('Backup:', backup)


if __name__ == '__main__':
    main()
