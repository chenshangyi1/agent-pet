#!/usr/bin/env python3
"""Read Codex hook metadata from stdin and queue sanitized events for Agent Pet."""

import json
import os
import re
import sys
import time
import uuid
from pathlib import Path

EVENTS = {
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "Stop",
    "Interrupt",
    "SessionEnd",
}


def clean(value, limit):
    if not isinstance(value, str):
        return ""
    return re.sub(r"\s+", " ", value).strip()[:limit]


def main():
    try:
        raw = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}
    except Exception:
        data = {}

    if not isinstance(data, dict):
        data = {}

    raw_event = str(data.get("hook_event_name") or data.get("event") or "").strip()
    session_id = clean(data.get("session_id") or data.get("sessionId"), 256)
    if raw_event not in EVENTS or not session_id or session_id in {"__proto__", "constructor", "prototype"}:
        sys.stdout.write("{}\n")
        return 0

    event = "Stop" if raw_event == "Interrupt" else raw_event
    cwd = str(data.get("cwd") or "").strip().rstrip("/\\")
    workspace = clean(os.path.basename(cwd), 64) if cwd else ""
    tool = clean(data.get("tool_name") or data.get("toolName"), 100)
    tool_id = clean(data.get("tool_use_id") or data.get("toolUseId"), 256)

    now = int(time.time() * 1000)
    event_id = uuid.uuid4().hex
    payload = {
        "v": 1,
        "id": event_id,
        "provider": "codex",
        "sessionId": session_id,
        "event": event,
        "at": now,
    }
    if workspace:
        payload["workspace"] = workspace
    if tool:
        payload["tool"] = tool
    if tool_id:
        payload["toolId"] = tool_id
    if raw_event == "Interrupt":
        payload["terminationReason"] = "USER_CANCELED"

    base = Path(os.environ.get("AGENT_PET_DATA") or (Path.home() / ".dsh" / "companion"))
    inbox = base / "codex" / "inbox"
    try:
        inbox.mkdir(parents=True, exist_ok=True, mode=0o700)
        name = f"{event_id}.json"
        tmp = inbox / f".{name}.{os.getpid()}.tmp"
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        tmp.chmod(0o600)
        os.replace(tmp, inbox / name)
    except Exception:
        pass

    sys.stdout.write("{}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
