#!/usr/bin/env python3
"""使用量の上限: 週の使用率が開始時点から DEW_BUDGET_PCT(既定 10)ポイント増えたら作業を止める。

PreToolUse フックとして、ツールを使う直前に毎回呼ばれる。
- 開始時点は .claude/budget/baseline.json。なければ今の値を開始時点として作る
- 上限に達したら {"continue": false} を返し、Claude の処理を止める
- 続けるときは baseline.json を消す(次のツール実行時に今の値で開始し直す)
- 週の枠がリセットされたら(resets_at が変わったら)、開始時点を今の値に置き直す
使用率は statusline.py が書き出した値で、最後の応答時点のもの(少し遅れる)。
"""
import json
import os
import sys
from pathlib import Path

sys.stdin.read()  # フックの入力は使わない
project = Path(os.environ.get("CLAUDE_PROJECT_DIR", "."))
budget_dir = project / ".claude" / "budget"
state_file = budget_dir / "state.json"
base_file = budget_dir / "baseline.json"
limit = float(os.environ.get("DEW_BUDGET_PCT", "10"))

try:
    state = json.loads(state_file.read_text())
except (OSError, ValueError):
    sys.exit(0)  # まだ使用率が届いていない(Pro / Max 以外、またはセッション開始直後)

try:
    base = json.loads(base_file.read_text())
except (OSError, ValueError):
    base = None

if base is None or base.get("resets_at") != state.get("resets_at"):
    base_file.write_text(json.dumps({"seven_day": state["seven_day"], "resets_at": state.get("resets_at")}))
    sys.exit(0)

used = state["seven_day"] - base["seven_day"]
if used >= limit:
    print(json.dumps({
        "continue": False,
        "stopReason": (
            f"週の使用量が開始時点から {used:.1f}% 増え、上限 {limit:.0f}% に達したので止めました"
            f"(週の使用率 {state['seven_day']:.0f}%)。"
            "続けるときは .claude/budget/baseline.json を消してから再開してください。"
        ),
    }, ensure_ascii=False))
sys.exit(0)
