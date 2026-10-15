#!/usr/bin/env python3
"""ステータスライン: 使用率を表示し、週の使用率をファイルに書き出す(budget_guard.py が読む)。

Claude Code はステータスラインのスクリプトにだけ rate_limits(5時間 / 7日の使用率)を渡す。
フックには渡されないため、ここで .claude/budget/state.json に保存する。
rate_limits は claude.ai の Pro / Max のときだけ、セッションの最初の応答のあとに届く。
"""
import json
import os
import sys
import time
from pathlib import Path

data = json.load(sys.stdin)
project = Path(data.get("workspace", {}).get("project_dir") or os.environ.get("CLAUDE_PROJECT_DIR") or ".")
budget_dir = project / ".claude" / "budget"

rate = data.get("rate_limits") or {}
week = rate.get("seven_day") or {}
five = rate.get("five_hour") or {}
week_pct = week.get("used_percentage")

parts = [data.get("model", {}).get("display_name", "?")]
ctx = (data.get("context_window") or {}).get("used_percentage")
if ctx is not None:
    parts.append(f"ctx {ctx:.0f}%")
if five.get("used_percentage") is not None:
    parts.append(f"5h {five['used_percentage']:.0f}%")

if week_pct is not None:
    budget_dir.mkdir(parents=True, exist_ok=True)
    state = {"seven_day": week_pct, "resets_at": week.get("resets_at"), "updated": time.time()}
    tmp = budget_dir / "state.json.tmp"
    tmp.write_text(json.dumps(state))
    tmp.replace(budget_dir / "state.json")

    label = f"週 {week_pct:.0f}%"
    base_file = budget_dir / "baseline.json"
    if base_file.exists():
        try:
            base = json.loads(base_file.read_text())
            limit = float(os.environ.get("DEW_BUDGET_PCT", "10"))
            if base.get("resets_at") == week.get("resets_at"):
                label += f"(今回 +{week_pct - base['seven_day']:.1f}/{limit:.0f}%)"
        except (ValueError, KeyError):
            pass
    parts.append(label)

print(" | ".join(parts))
