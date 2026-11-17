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


APP_NAME = 'Agent Pet'
APP_DISPLAY_NAME = '小鑫'
APP_EXEC_NAME = 'AgentPet'
APP_BUNDLE_ID = 'local.chenmingxin.agent-pet'
APP_VERSION = '0.3.0'


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
        root / 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
        Path('/Applications/Electron.app/Contents/MacOS/Electron'),
        root / 'node_modules/.bin/electron',
        Path(which_electron) if which_electron else None,
        user / '.dsh/electron/Electron.app/Contents/MacOS/Electron',
    ]
    for candidate in candidates:
        if candidate and candidate.is_file():
            return candidate
    return None


def resolve_electron_bundle(electron):
    if electron is None:
        return None
    probe_paths = [electron]
    if electron.is_symlink():
        probe_paths.append(electron.resolve())
    for candidate in probe_paths:
        if (
            candidate.parent.name == 'MacOS'
            and candidate.parent.parent.name == 'Contents'
            and candidate.parent.parent.parent.name.endswith('.app')
        ):
            bundle_dir = candidate.parent.parent.parent
            if (bundle_dir / 'Contents/Info.plist').is_file():
                return bundle_dir, candidate.name
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


def _remove_path(target):
    if target.is_symlink() or target.is_file():
        target.unlink()
    elif target.exists():
        shutil.rmtree(target)


def _load_plist(path):
    if not path.is_file():
        return {}
    with path.open('rb') as stream:
        data_dict = plistlib.load(stream)
    return data_dict if isinstance(data_dict, dict) else {}


def _write_plist(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('wb') as stream:
        plistlib.dump(payload, stream)


def _is_macho(path):
    if not path.is_file():
        return False
    try:
        header = path.read_bytes()[:4]
    except OSError:
        return False
    return header in (
        b'\xfe\xed\xfa\xce',
        b'\xce\xfa\xed\xfe',
        b'\xfe\xed\xfa\xcf',
        b'\xcf\xfa\xed\xfe',
        b'\xca\xfe\xba\xbe',
        b'\xbe\xba\xfe\xca',
    )


def _copy_app_icon(app_dir, info_plist):
    icon_src = root / 'assets/agent-pet.icns'
    if not icon_src.is_file():
        return
    resources = app_dir / 'Contents/Resources'
    resources.mkdir(parents=True, exist_ok=True)
    old_icon = resources / 'electron.icns'
    if old_icon.exists():
        old_icon.unlink()
    shutil.copy2(icon_src, resources / 'agent-pet.icns')
    info_plist['CFBundleIconFile'] = 'agent-pet.icns'
    info_plist.pop('CFBundleIconName', None)


def _rebrand_helpers(stage):
    frameworks = stage / 'Contents/Frameworks'
    if not frameworks.is_dir():
        return
    for helper_app in sorted(frameworks.glob('*.app')):
        plist_path = helper_app / 'Contents/Info.plist'
        helper_plist = _load_plist(plist_path)
        old_id = str(helper_plist.get('CFBundleIdentifier') or '')
        is_electron_helper = helper_app.name.startswith('Electron Helper')
        if not is_electron_helper and not old_id.startswith('com.github.Electron'):
            continue

        suffix = helper_app.name[len('Electron Helper'):-len('.app')] if is_electron_helper else ''
        new_base = f'{APP_NAME} Helper{suffix}' if is_electron_helper else helper_app.stem
        old_exec = str(helper_plist.get('CFBundleExecutable') or helper_app.stem)
        macos_dir = helper_app / 'Contents/MacOS'
        src_exec = macos_dir / old_exec
        dst_exec = macos_dir / new_base
        if src_exec.exists() and src_exec != dst_exec:
            if dst_exec.exists():
                dst_exec.unlink()
            src_exec.rename(dst_exec)
        if dst_exec.exists():
            dst_exec.chmod(0o755)

        helper_plist.update({
            'CFBundleIdentifier': f'{APP_BUNDLE_ID}.helper',
            'CFBundleName': new_base,
            'CFBundleDisplayName': new_base,
            'CFBundleExecutable': new_base,
            'CFBundlePackageType': 'APPL',
            'LSUIElement': True,
        })
        _write_plist(plist_path, helper_plist)

        if is_electron_helper:
            new_helper_app = helper_app.with_name(f'{new_base}.app')
            if new_helper_app != helper_app:
                _remove_path(new_helper_app)
                helper_app.rename(new_helper_app)


def _sign_if_native(app_dir, main_exec):
    codesign = Path('/usr/bin/codesign')
    if not codesign.is_file() or not _is_macho(main_exec):
        return
    subprocess.run([str(codesign), '--force', '--deep', '--sign', '-', str(app_dir)], check=True)


def _refresh_launch_services(app_dir):
    # Skip touching global LaunchServices during isolated tests overriding install targets.
    if os.environ.get('AGENT_PET_ELECTRON') or os.environ.get('AGENT_PET_DATA'):
        return
    lsregister = Path('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister')
    if lsregister.is_file():
        subprocess.run([str(lsregister), '-f', str(app_dir)], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _install_branded_app(app, src_bundle, src_exec_name):
    app.parent.mkdir(parents=True, exist_ok=True)
    stage = app.parent / f'.{app.name}.agent-pet-staging-{os.getpid()}'
    _remove_path(stage)
    try:
        shutil.copytree(src_bundle, stage, symlinks=True)

        src_exec = stage / 'Contents/MacOS' / src_exec_name
        dst_exec = stage / 'Contents/MacOS' / APP_EXEC_NAME
        if src_exec.exists() and src_exec != dst_exec:
            if dst_exec.exists():
                dst_exec.unlink()
            src_exec.rename(dst_exec)
        dst_exec.chmod(0o755)

        plist_path = stage / 'Contents/Info.plist'
        info = _load_plist(plist_path)
        info.pop('ElectronAsarIntegrity', None)
        info.update({
            'CFBundleName': APP_NAME,
            'CFBundleDisplayName': APP_DISPLAY_NAME,
            'CFBundleExecutable': APP_EXEC_NAME,
            'CFBundleIdentifier': APP_BUNDLE_ID,
            'CFBundleShortVersionString': APP_VERSION,
            'CFBundleVersion': APP_VERSION,
            'CFBundlePackageType': 'APPL',
            'LSUIElement': True,
            'NSMicrophoneUsageDescription': '用于桌宠小鑫的语音输入',
            'NSSpeechRecognitionUsageDescription': '用于桌宠小鑫识别你的语音并与 AI 对话',
        })
        _copy_app_icon(stage, info)
        _write_plist(plist_path, info)

        _rebrand_helpers(stage)

        resources = stage / 'Contents/Resources'
        resources.mkdir(parents=True, exist_ok=True)
        for stale in ('default_app.asar', 'app.asar', 'app'):
            _remove_path(resources / stale)

        app_code = resources / 'app'
        app_code.mkdir(parents=True, exist_ok=True)
        (app_code / 'package.json').write_text(
            json.dumps({'name': 'agent-pet', 'version': APP_VERSION, 'main': 'main.js'}, indent=2) + '\n'
        )
        runtime_main = str(root / 'runtime/main.cjs')
        (app_code / 'main.js').write_text(
            "'use strict';\n"
            'delete process.env.ELECTRON_RUN_AS_NODE;\n'
            f'process.env.AGENT_PET_ROOT = {json.dumps(str(root))};\n'
            f'require({json.dumps(runtime_main)});\n'
        )

        _sign_if_native(stage, dst_exec)

        _remove_path(app)
        stage.rename(app)
    finally:
        _remove_path(stage)


def _install_shell_launcher(app, electron):
    if (app / 'Contents/Frameworks').exists():
        _remove_path(app)
    macos = app / 'Contents/MacOS'
    macos.mkdir(parents=True, exist_ok=True)
    launcher = macos / APP_EXEC_NAME
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
            f'  {shlex.quote(str(root / "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"))} \\',
            '  "/Applications/Electron.app/Contents/MacOS/Electron" \\',
            f'  {shlex.quote(str(root / "node_modules/.bin/electron"))} \\',
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
    info = {
        'CFBundleName': APP_NAME,
        'CFBundleDisplayName': APP_DISPLAY_NAME,
        'CFBundleExecutable': APP_EXEC_NAME,
        'CFBundleIdentifier': APP_BUNDLE_ID,
        'CFBundleShortVersionString': APP_VERSION,
        'CFBundleVersion': APP_VERSION,
        'CFBundlePackageType': 'APPL',
        'LSUIElement': True,
        'NSMicrophoneUsageDescription': '用于桌宠小鑫的语音输入',
        'NSSpeechRecognitionUsageDescription': '用于桌宠小鑫识别你的语音并与 AI 对话',
    }
    _copy_app_icon(app, info)
    _write_plist(app / 'Contents/Info.plist', info)


def install_app():
    app = user / 'Applications/Agent Pet.app'
    if app.exists():
        shutil.copytree(app, backup / 'Agent Pet.app', symlinks=True)
    electron = resolve_electron()
    bundle = resolve_electron_bundle(electron)
    if bundle is not None:
        src_bundle, src_exec_name = bundle
        _install_branded_app(app, src_bundle, src_exec_name)
    else:
        _install_shell_launcher(app, electron)
    _refresh_launch_services(app)
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
    print('Open Manager (+ in NotchPanel or tray -> 管理 AI Agent...) to manage connected AI Agents.')
    print('Backup:', backup)


if __name__ == '__main__':
    main()
