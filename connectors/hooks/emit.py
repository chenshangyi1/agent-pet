#!/usr/bin/env python3
"""Unified non-blocking hook emitter for Agent Pet.

Reads hook metadata from stdin, strips all prompts/inputs/outputs, writes
normalized v1 lifecycle events to $AGENT_PET_DATA/<provider>/inbox/*.json,
prints '{}' and always exits 0 so host AI agents are never blocked.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import sys
import time
from typing import Optional
from urllib.parse import unquote, urlparse
import uuid

STANDARD_EVENTS = {
    'SessionStart',
    'SessionEnd',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
    'Notification',
    'PermissionDenied',
    'Stop',
    'StopFailure',
    'PreInvocation',
    'PostInvocation',
    'Interrupt',
}

EVENT_MAP = {
    'sessionStart': 'SessionStart',
    'sessionEnd': 'SessionEnd',
    'beforeSubmitPrompt': 'UserPromptSubmit',
    'preToolUse': 'PreToolUse',
    'postToolUse': 'PostToolUse',
    'postToolUseFailure': 'PostToolUseFailure',
    'stop': 'Stop',
    'subagentStop': 'Stop',
    # Gemini CLI
    'BeforeAgent': 'UserPromptSubmit',
    'AfterAgent': 'Stop',
    'BeforeTool': 'PreToolUse',
    'AfterTool': 'PostToolUse',
    # GitHub Copilot CLI
    'userPromptSubmitted': 'UserPromptSubmit',
    'errorOccurred': 'StopFailure',
    # Windsurf Cascade
    'pre_user_prompt': 'UserPromptSubmit',
    'pre_read_code': 'PreToolUse',
    'post_read_code': 'PostToolUse',
    'pre_write_code': 'PreToolUse',
    'post_write_code': 'PostToolUse',
    'pre_run_command': 'PreToolUse',
    'post_run_command': 'PostToolUse',
    'pre_mcp_tool_use': 'PreToolUse',
    'post_mcp_tool_use': 'PostToolUse',
    'post_cascade_response': 'Stop',
    'post_cascade_response_with_transcript': 'Stop',
    # Cline
    'TaskStart': 'SessionStart',
    'TaskComplete': 'Stop',
    'TaskCancel': 'Interrupt',
}

WINDSURF_TOOL_NAMES = {
    'pre_read_code': 'read_code',
    'post_read_code': 'read_code',
    'pre_write_code': 'write_code',
    'post_write_code': 'write_code',
    'pre_run_command': 'run_command',
    'post_run_command': 'run_command',
    'pre_mcp_tool_use': 'mcp_tool',
    'post_mcp_tool_use': 'mcp_tool',
}

BAD_IDS = {'__proto__', 'constructor', 'prototype'}


def clean(value, limit):
    if not isinstance(value, str):
        return ''
    return re.sub(r'\s+', ' ', value).strip()[:limit]


def data_root() -> Path:
    override = os.environ.get('AGENT_PET_DATA') or os.environ.get('DSH_COMPANION_DATA')
    if override:
        return Path(override)
    home = os.environ.get('HOME') or pwd.getpwuid(os.getuid()).pw_dir
    return Path(home) / '.dsh/companion'


def _uri_to_local_path(value) -> str:
    if not isinstance(value, str):
        return ''
    raw = value.strip()
    if not raw:
        return ''
    parsed = urlparse(raw)
    if parsed.scheme == 'file':
        if parsed.netloc not in ('', 'localhost'):
            return ''
        return unquote(parsed.path).strip().rstrip('/\\')
    if not parsed.scheme and os.path.isabs(raw):
        return raw.rstrip('/\\')
    return ''


def extract_cwd(payload: dict) -> str:
    for key in ('cwd', 'workspace', 'project_root', 'projectRoot'):
        val = payload.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip().rstrip('/\\')
    for key in ('workspace_roots', 'workspaceRoots', 'workspacePaths'):
        val = payload.get(key)
        if isinstance(val, list) and val and isinstance(val[0], str) and val[0].strip():
            return val[0].strip().rstrip('/\\')
    for key in ('workspaceUris', 'workspace_uris'):
        val = payload.get(key)
        items = val if isinstance(val, list) else ([val] if isinstance(val, str) else [])
        for item in items:
            decoded = _uri_to_local_path(item)
            if decoded:
                return decoded
    tool_info = payload.get('tool_info')
    if isinstance(tool_info, dict):
        file_path = tool_info.get('file_path')
        if isinstance(file_path, str) and file_path.strip():
            return str(Path(file_path.strip()).parent)
    return ''


def normalize_payload(payload: dict, provider: str, fmt: str, fallback_event: str = '') -> Optional[dict]:
    if not re.fullmatch(r'[a-z0-9-]+', provider) or provider in BAD_IDS:
        return None

    raw_event = clean(
        payload.get('hookEventName')
        or payload.get('hook_event_name')
        or payload.get('agent_action_name')
        or payload.get('event')
        or fallback_event,
        64,
    )
    if not raw_event:
        return None

    event = EVENT_MAP.get(raw_event, raw_event)
    if event not in STANDARD_EVENTS:
        return None

    session_id = clean(
        payload.get('session_id')
        or payload.get('conversation_id')
        or payload.get('conversationId')
        or payload.get('sessionId')
        or payload.get('trajectory_id')
        or payload.get('trajectoryId')
        or payload.get('taskId')
        or payload.get('task_id'),
        256,
    )
    cwd = extract_cwd(payload)

    if not session_id and fmt in ('kiro', 'cline', 'windsurf', 'copilot') and cwd:
        session_id = f'{provider}-' + hashlib.sha256(cwd.encode('utf-8')).hexdigest()[:12]

    if not session_id or session_id in BAD_IDS:
        return None

    canonical_event = 'Stop' if event == 'Interrupt' else event
    event_id = uuid.uuid4().hex
    out = {
        'v': 1,
        'provider': provider,
        'sessionId': session_id,
        'event': canonical_event,
        'id': event_id,
        'at': int(time.time() * 1000),
    }

    if cwd:
        workspace = clean(os.path.basename(cwd), 64)
        if workspace:
            out['workspace'] = workspace

    tool_call = payload.get('toolCall')
    if isinstance(tool_call, dict):
        tool = clean(tool_call.get('name'), 100)
        tool_id = clean(tool_call.get('id'), 256)
    else:
        tool = clean(
            payload.get('tool_name')
            or payload.get('toolName')
            or WINDSURF_TOOL_NAMES.get(raw_event, ''),
            100,
        )
        tool_id = clean(payload.get('tool_use_id') or payload.get('toolUseId') or payload.get('execution_id'), 256)

    if tool:
        out['tool'] = tool
    if tool_id:
        out['toolId'] = tool_id

    notification = clean(payload.get('notification_type') or payload.get('notificationType'), 64)
    if notification:
        out['notification'] = notification

    termination = clean(payload.get('terminationReason'), 64)
    if event == 'Interrupt' or clean(payload.get('status'), 32).lower() == 'aborted':
        termination = 'USER_CANCELED'
    if termination:
        out['terminationReason'] = termination

    if payload.get('error') or clean(payload.get('status'), 32).lower() == 'error':
        out['hasError'] = True

    return out


def emit_event(provider: str, fmt: str = 'auto', fallback_event: str = '') -> None:
    raw = sys.stdin.buffer.read(1_048_577)
    if len(raw) > 1_048_576:
        return
    try:
        payload = json.loads(raw.decode('utf-8')) if raw.strip() else {}
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        return

    out = normalize_payload(payload, provider, fmt, fallback_event)
    if not out:
        return

    inbox = data_root() / provider / 'inbox'
    inbox.mkdir(parents=True, exist_ok=True, mode=0o700)
    filename = out['id'] + '.json'
    tmp = inbox / ('.' + out['id'] + '.' + str(os.getpid()) + '.tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as stream:
        json.dump(out, stream, ensure_ascii=False)
    os.replace(tmp, inbox / filename)


def main(default_provider: str = '', default_format: str = 'auto') -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--provider', default=default_provider)
    parser.add_argument('--format', default=default_format)
    parser.add_argument('--event', default='')
    args, _ = parser.parse_known_args()
    try:
        if args.provider:
            emit_event(args.provider, args.format, args.event)
    except Exception:
        pass
    sys.stdout.write('{"cancel":false}\n' if args.format == 'cline' else '{}\n')
    sys.stdout.flush()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
