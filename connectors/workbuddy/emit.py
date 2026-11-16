#!/usr/bin/env python3
"""Delegate WorkBuddy hooks to the unified Agent Pet emitter."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'hooks'))
from emit import main  # noqa: E402

if __name__ == '__main__':
    raise SystemExit(main('workbuddy', 'standard'))
