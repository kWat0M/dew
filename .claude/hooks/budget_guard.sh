#!/usr/bin/env bash
# 使用量の上限: 週の使用率が開始時点から DEW_BUDGET_PCT(既定 10)ポイント増えたら作業を止める。
#
# PreToolUse フックとして、ツールを使う直前に毎回呼ばれる。
# - 開始時点は .claude/budget/baseline.json。なければ今の値を開始時点として作る
# - 上限に達したら {"continue": false} を返し、Claude の処理を止める
# - 続けるときは baseline.json を消す(次のツール実行時に今の値で開始し直す)
# - 週の枠がリセットされたら(resets_at が変わったら)、開始時点を今の値に置き直す
# 使用率は statusline.sh が書き出した値で、最後の応答時点のもの(少し遅れる)。
# 必要なもの: jq

cat >/dev/null  # フックの入力は使わない

budget_dir="${CLAUDE_PROJECT_DIR:-.}/.claude/budget"
state_file="$budget_dir/state.json"
base_file="$budget_dir/baseline.json"
limit="${DEW_BUDGET_PCT:-10}"

# まだ使用率が届いていない(Pro / Max 以外、またはセッション開始直後)
jq -e '.seven_day | numbers' "$state_file" >/dev/null 2>&1 || exit 0

# 開始時点がない・壊れている・週の枠がリセットされた → 今の値で開始し直す
if ! jq -e --slurpfile s "$state_file" \
     '(.seven_day | numbers) and .resets_at == $s[0].resets_at' \
     "$base_file" >/dev/null 2>&1; then
  jq -c '{seven_day, resets_at}' "$state_file" > "$base_file"
  exit 0
fi

# 上限に達していたら止める(達していなければ何も出力しない)
jq -nc --slurpfile s "$state_file" --slurpfile b "$base_file" --arg limit "$limit" '
  def f1: (. * 10 | round / 10) | tostring | if test("\\.") then . else . + ".0" end;
  $s[0].seven_day as $now
  | ($now - $b[0].seven_day) as $used
  | ($limit | tonumber) as $lim
  | if $used >= $lim then {
      continue: false,
      stopReason: (
        "週の使用量が開始時点から \($used | f1)% 増え、上限 \($lim | round)% に達したので止めました"
        + "(週の使用率 \($now | round)%)。"
        + "続けるときは .claude/budget/baseline.json を消してから再開してください。"
      )
    } else empty end'
exit 0
