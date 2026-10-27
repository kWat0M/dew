#!/usr/bin/env bash
# Claude Code status line
#   Line 1: [ model · effort | workspace/subdir | branch* +add -del ?untracked ]
#   Line 2: ctx bar % | 5h bar % ↺reset | 7d bar % ↺reset    (budget used / limit%)
#   1行目の色と区切りは ~/.config/starship.toml(catppuccin_mocha + cy_*)に合わせる

input=$(cat)
j() { printf '%s' "$input" | jq -r "$1 // empty" 2>/dev/null; }

# ─── Powerline helpers ────────────────────────────────────────────────
CAP=$'\xee\x82\xb2'  # U+E0B2  行頭
SEP=$'\xee\x82\xbc'  # U+E0BC  セグメント間(斜め)
PL=$'\xee\x82\xb0'   # U+E0B0  行末
ESC=$'\033'
RESET="${ESC}[0m"
h2r() { local h="${1#\#}"; echo "$((16#${h:0:2}));$((16#${h:2:2}));$((16#${h:4:2}))"; }

_prev=""; _out=""
_seg() {  # $1=bg $2=fg $3=text
  if [ -n "$_prev" ]; then
    _out+="${ESC}[38;2;$(h2r "$_prev")m${ESC}[48;2;$(h2r "$1")m${SEP}"
  else
    _out+="${ESC}[38;2;$(h2r "$1")m${CAP}"
  fi
  _out+="${ESC}[48;2;$(h2r "$1")m${ESC}[38;2;$(h2r "$2")m ${3} "
  _prev="$1"
}
_end() {  # 結果を _line に入れて状態をリセット
  [ -n "$_prev" ] && _out+="${RESET}${ESC}[38;2;$(h2r "$_prev")m${PL}${RESET}"
  _line="$_out"; _prev=""; _out=""
}

# ─── Palette (starship の catppuccin_mocha と cy_*) ──────────────────────
CY_GREEN="#00ff9f"; CY_YELLOW="#fee801"
BASE="#2c2c44"; MANTLE="#181825"; CRUST="#11111b"
GREEN="#a6e3a1"; RED="#f38ba8"; OVERLAY1="#7f849c"
fg() { printf '%s' "${ESC}[38;2;$(h2r "$1")m"; }

# ─── Line 1: model · effort ───────────────────────────────────────────
model=$(j '.model.display_name')
effort=$(j '.effort.level')
# 古いバージョンなど effort が無い場合は settings.json の既定値で代用
if [ -z "$effort" ] && [ -f "$HOME/.claude/settings.json" ]; then
  effort=$(jq -r '.effortLevel // empty' "$HOME/.claude/settings.json" 2>/dev/null)
fi
me="${model:-?}"
[ -n "$effort" ] && me+=" · ${effort}"
_seg "$CY_GREEN" "$CRUST" "$me"

# ─── Line 1 (続き): workspace[/subdir] | branch* git status ────────────────
cwd=$(j '.workspace.current_dir'); [ -z "$cwd" ] && cwd=$(j '.cwd')
proj=$(j '.workspace.project_dir'); [ -z "$proj" ] && proj="$cwd"
ws="${proj##*/}"
# project_dir より下にいるときは相対パスを付ける (例: myapp/src/lib)
case "$cwd" in
  "$proj"/*) ws="${ws}/${cwd#"$proj"/}" ;;
esac
[ "${#ws}" -gt 40 ] && ws="…${ws: -39}"

branch=""; gstat=""
g() { git -C "$cwd" --no-optional-locks "$@" 2>/dev/null; }
if [ -n "$cwd" ] && g rev-parse --is-inside-work-tree >/dev/null; then
  branch=$(g branch --show-current)
  # detached HEAD のときは短縮ハッシュ
  [ -z "$branch" ] && branch=$(g rev-parse --short HEAD)
  [ "${#branch}" -gt 40 ] && branch="${branch:0:39}…"
  porcelain=$(g status --porcelain)
  if [ -n "$porcelain" ]; then
    branch+="*"
    # 追加/削除行数 (staged + unstaged) と未追跡ファイル数
    read -r a d < <(g diff HEAD --numstat | awk '{a+=$1; d+=$2} END {print a+0, d+0}')
    u=$(printf '%s\n' "$porcelain" | grep -c '^??')
    [ "${a:-0}" -gt 0 ] && gstat+=" $(fg "$GREEN")+${a}"
    [ "${d:-0}" -gt 0 ] && gstat+=" $(fg "$RED")-${d}"
    [ "$u" -gt 0 ]      && gstat+=" $(fg "$CY_YELLOW")?${u}"
  fi
fi
_seg "$BASE" "$CY_GREEN" "${ws:-?}"
# branch と git status は starship と同じく1つの mantle セグメントに入れる
[ -n "$branch" ] && _seg "$MANTLE" "$CY_YELLOW" "$(printf "\xef\x84\x93 \xef\x84\xa6") ${branch}${gstat}"
_end; line1="$_line"

# ─── Line 2: ctx | 5h | 7d ────────────────────────────────────────────
now=$(date +%s)

bar_color() {
  if   [ "$1" -ge 76 ]; then printf '%s' "${ESC}[31m"
  elif [ "$1" -ge 51 ]; then printf '%s' "${ESC}[33m"
  else                       printf '%s' "${ESC}[32m"
  fi
}
make_bar() {  # $1=pct(int)
  local filled=$(( $1 / 10 )) bar="" i=0
  [ "$filled" -gt 10 ] && filled=10
  while [ "$i" -lt "$filled" ]; do bar+="▰"; i=$((i+1)); done
  while [ "$i" -lt 10 ];        do bar+="▱"; i=$((i+1)); done
  printf '%s%s%s' "$(bar_color "$1")" "$bar" "$RESET"
}
# 残り時間: 3d04h12m / 4h05m / 12m
fmt_remain() {
  local secs=$(( $1 - now ))
  [ "$secs" -le 0 ] && { printf 'now'; return; }
  local d=$(( secs / 86400 )) h=$(( (secs % 86400) / 3600 )) m=$(( (secs % 3600) / 60 ))
  if   [ "$d" -gt 0 ]; then printf '%dd%02dh%02dm' "$d" "$h" "$m"
  elif [ "$h" -gt 0 ]; then printf '%dh%02dm' "$h" "$m"
  else                      printf '%dm' "$m"
  fi
}
rate_part() {  # $1=label $2=pct $3=resets_at
  [ -z "$2" ] && return
  local p; p=$(printf '%.0f' "$2")
  local s="$1 $(make_bar "$p") ${p}%"
  [ -n "$3" ] && s+=" ↺$(fmt_remain "${3%.*}")"
  printf '%s' "$s"
}

parts=()
ctx_pct=$(j '.context_window.used_percentage')
if [ -n "$ctx_pct" ]; then
  c=$(printf '%.0f' "$ctx_pct")
  parts+=("ctx $(make_bar "$c") ${c}%")
fi
p5=$(rate_part "5h" "$(j '.rate_limits.five_hour.used_percentage')" "$(j '.rate_limits.five_hour.resets_at')")
[ -n "$p5" ] && parts+=("$p5")
p7=$(rate_part "7d" "$(j '.rate_limits.seven_day.used_percentage')" "$(j '.rate_limits.seven_day.resets_at')")
[ -n "$p7" ] && parts+=("$p7")

line2=""
for p in "${parts[@]}"; do
  [ -n "$line2" ] && line2+="  |  "
  line2+="$p"
done

# ─── budget_guard 用に週の使用率を書き出す ───────────────────────────────
# budget_guard.sh が .claude/budget/state.json を読んで上限を判定する。
# 書きかけを読まれないよう、一時ファイルに書いてから mv で置き換える
if [ -n "$(j '.rate_limits.seven_day.used_percentage')" ]; then
  bdir="${CLAUDE_PROJECT_DIR:-$proj}/.claude/budget"
  if mkdir -p "$bdir" 2>/dev/null; then
    tmp="$bdir/.state.json.$$"
    printf '%s' "$input" | jq -c '{
        seven_day: .rate_limits.seven_day.used_percentage,
        resets_at: .rate_limits.seven_day.resets_at
      }' > "$tmp" 2>/dev/null && mv -f "$tmp" "$bdir/state.json" || rm -f "$tmp"
  fi

  # 開始時点からの増加量を、2行目の右端に (3.2 / 40%) の形で出す。
  # baseline.json がない、または週の枠がリセット済みなら出さない(budget_guard が次に作り直す)
  limit="${BUDGET_PCT:-10}"
  budget=$(printf '%s' "$input" | jq -r --slurpfile b "$bdir/baseline.json" --arg limit "$limit" '
    .rate_limits.seven_day as $s
    | select(($b[0].seven_day | numbers) and $b[0].resets_at == $s.resets_at)
    | ($s.used_percentage - $b[0].seven_day) as $used
    | ($limit | tonumber) as $lim
    | (if $used >= $lim then "red" elif $used >= $lim * 0.75 then "yellow" else "dim" end)
      + " " + ($used * 10 | round / 10 | tostring | if test("\\.") then . else . + ".0" end)
      + " " + ($lim | round | tostring)' 2>/dev/null)
  if [ -n "$budget" ]; then
    read -r level used lim <<< "$budget"
    case "$level" in
      red)    bc="${ESC}[31m" ;;
      yellow) bc="${ESC}[33m" ;;
      *)      bc="$(fg "$OVERLAY1")" ;;
    esac
    [ -n "$line2" ] && line2+="    "
    line2+="${bc}(${used} / ${lim}%)${RESET}"
  fi
fi

# ─── Output ───────────────────────────────────────────────────────────
printf '%s' "$line1"
[ -n "$line2" ] && printf '\n%s' "$line2"
