#!/usr/bin/env python3
"""A non-blocking Antigravity observer. Keep only lifecycle metadata; always output {} and exit 0."""
import json
import os
from pathlib import Path
import pwd
import sys
import time
import uuid

SUPPORTED_EVENTS = {
    'SessionStart',
    'PreInvocation',
    'PostToolUse',
    'PostInvocation',
    'Stop',
}


def data_root() -> Path:
    override = os.environ.get('AGENT_PET_DATA')
    if override:
        return Path(override)
    home = os.environ.get('HOME') or pwd.getpwuid(os.getuid()).pw_dir
    return Path(home) / '.dsh/companion'


def main() -> None:
    raw = sys.stdin.buffer.read(1_048_577)
    if not raw or len(raw) > 1_048_576:
        return
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        return
    event = payload.get('hookEventName', '')
    session = payload.get('conversationId', '')
    if not isinstance(session, str) or not session or len(session) > 256:
        return
    if event not in SUPPORTED_EVENTS:
        return

    event_id = uuid.uuid4().hex
    data = {
        'v': 1,
        'provider': 'antigravity',
        'sessionId': session,
        'event': event,
        'id': event_id,
        'at': time.time_ns() / 1_000_000,
    }

    tool_call = payload.get('toolCall')
    if isinstance(tool_call, dict):
        tool_name = tool_call.get('name')
        tool_id = tool_call.get('id')
        if isinstance(tool_name, str) and tool_name:
            data['tool'] = tool_name[:256]
        if isinstance(tool_id, str) and tool_id:
            data['toolId'] = tool_id[:256]

    if isinstance(payload.get('terminationReason'), str) and payload['terminationReason']:
        data['terminationReason'] = payload['terminationReason'][:64]

    if payload.get('error'):
        data['hasError'] = True

    cwd = payload.get('cwd')
    if not isinstance(cwd, str) or not cwd:
        ws = payload.get('workspacePaths')
        if isinstance(ws, list) and ws and isinstance(ws[0], str):
            cwd = ws[0]
    if isinstance(cwd, str) and cwd:
        name = Path(cwd).name
        if name:
            data['workspace'] = name[:64]

    inbox = data_root() / 'antigravity/inbox'
    inbox.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = inbox / (event_id + '.tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(data, stream, ensure_ascii=False)
    os.replace(tmp, inbox / (event_id + '.json'))


try:
    main()
except Exception:
    pass  # Never block Antigravity's fail-closed hook runner.

sys.stdout.write('{}\n')
sys.stdout.flush()
sys.exit(0)
