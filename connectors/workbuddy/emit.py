#!/usr/bin/env python3
"""A non-blocking observer. Keep only lifecycle metadata; always exit successfully."""
import json
import os
from pathlib import Path
import sys
import time
import uuid

def main():
    raw = sys.stdin.buffer.read(1_048_577)
    if len(raw) > 1_048_576:
        return
    payload = json.loads(raw)
    event = payload.get('hook_event_name', '')
    session = payload.get('session_id', '')
    if not isinstance(session, str) or not session or len(session) > 256:
        return
    if event not in {'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
                     'PostToolUseFailure', 'Stop', 'StopFailure', 'Notification', 'PermissionDenied'}:
        return
    event_id = uuid.uuid4().hex
    data = {'v': 1, 'provider': 'workbuddy', 'sessionId': session, 'event': event,
            'id': event_id, 'at': time.time_ns() / 1_000_000}
    for source, target in [('tool_name', 'tool'), ('tool_use_id', 'toolId'), ('notification_type', 'notification')]:
        value = payload.get(source)
        if isinstance(value, str):
            data[target] = value[:256]
    root = Path(os.environ.get('AGENT_PET_DATA', str(Path.home() / '.dsh/companion')))
    inbox = root / 'workbuddy/inbox'
    inbox.mkdir(parents=True, exist_ok=True, mode=0o700)
    # One event per file makes concurrent hooks safe, without locks in the Agent.
    tmp = inbox / (event_id + '.tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(data, stream, ensure_ascii=False)
    os.replace(tmp, inbox / (event_id + '.json'))

try:
    main()
except Exception:
    pass  # A desktop decoration must never interrupt a task or emit a decision.
sys.exit(0)
