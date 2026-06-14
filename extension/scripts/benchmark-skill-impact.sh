#!/usr/bin/env bash
# Compares an agent task with skills available vs. with skills disabled
# (claude --disable-slash-commands), running each variant once in its own
# disposable git worktree checked out at HEAD. Reports wall time, turn
# count, token usage, cost (from `claude --output-format json`), and the
# resulting diff.
#
# Usage:
#   extension/scripts/benchmark-skill-impact.sh [options]
#
# Run `--help` for options.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"

TASK=""
TASK_FILE=""
MODEL="sonnet"
PERMISSION_MODE="acceptEdits"
UNATTENDED=0
MAX_BUDGET="2.00"
TIMEOUT_SECONDS=300
KEEP=0
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: benchmark-skill-impact.sh [options]

Runs the same task twice via the Claude Code CLI in two disposable git
worktrees checked out at HEAD: once with skills available (default), and
once with --disable-slash-commands (no skills, i.e. "without this
extension's skill library"). Compares wall time, turn count, token usage,
cost, and the resulting diff. Writes a markdown report under
extension/scripts/bench-results/<run-id>/report.md.

Options:
  --task "<prompt>"       Inline task prompt.
  --task-file <path>      Read task prompt from file
                          (default: scripts/bench-tasks/default-task.md).
  --model <name>          Model alias/name (default: sonnet).
  --permission-mode <m>   Permission mode for non-unattended runs
                          (default: acceptEdits).
  --unattended            Use --permission-mode bypassPermissions
                          --dangerously-skip-permissions for both runs.
                          Safe here: each run is confined to its own
                          disposable worktree under .bench-tmp/.
  --max-budget-usd <n>    Per-run spend cap (default: 2.00). Note: loading
                          the global skill catalog alone costs roughly
                          $0.05-0.10 in cache-creation tokens before the
                          model responds, so very low caps will make the
                          "with skills" run fail with
                          error_max_budget_usd while "without skills"
                          (--disable-slash-commands) succeeds.
  --timeout <seconds>     Per-run wall-clock timeout (default: 300).
  --keep                  Keep worktrees and raw output after the run.
  --dry-run               Print the commands without invoking the API.
  -h, --help              Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --task) TASK="$2"; shift 2 ;;
    --task-file) TASK_FILE="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --permission-mode) PERMISSION_MODE="$2"; shift 2 ;;
    --unattended) UNATTENDED=1; shift ;;
    --max-budget-usd) MAX_BUDGET="$2"; shift 2 ;;
    --timeout) TIMEOUT_SECONDS="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "$TASK" ]]; then
  TASK_FILE="${TASK_FILE:-$SCRIPT_DIR/bench-tasks/default-task.md}"
  if [[ ! -f "$TASK_FILE" ]]; then
    echo "Task file not found: $TASK_FILE" >&2
    exit 1
  fi
  TASK="$(cat "$TASK_FILE")"
fi

RUN_ID="$(date +%Y%m%d-%H%M%S)"
BENCH_ROOT="$REPO_ROOT/.bench-tmp/$RUN_ID"
RESULTS_DIR="$SCRIPT_DIR/bench-results/$RUN_ID"
mkdir -p "$RESULTS_DIR"

WITH_DIR="$BENCH_ROOT/with-skills"
WITHOUT_DIR="$BENCH_ROOT/without-skills"

cleanup() {
  if [[ "$KEEP" -eq 0 && "$DRY_RUN" -eq 0 ]]; then
    git -C "$REPO_ROOT" worktree remove --force "$WITH_DIR" >/dev/null 2>&1 || true
    git -C "$REPO_ROOT" worktree remove --force "$WITHOUT_DIR" >/dev/null 2>&1 || true
    rm -rf "$BENCH_ROOT"
  fi
}
trap cleanup EXIT

echo "Run ID: $RUN_ID"
echo "Task:"
echo "---"
echo "$TASK"
echo "---"

if [[ "$DRY_RUN" -eq 0 ]]; then
  git -C "$REPO_ROOT" worktree add --detach --quiet "$WITH_DIR" HEAD
  git -C "$REPO_ROOT" worktree add --detach --quiet "$WITHOUT_DIR" HEAD
fi

run_variant() {
  local label="$1" dir="$2"; shift 2
  local extra_flags=("$@")
  local json_out="$RESULTS_DIR/$label.json"
  local log_out="$RESULTS_DIR/$label.log"

  local perm_flags=()
  if [[ "$UNATTENDED" -eq 1 ]]; then
    perm_flags=(--permission-mode bypassPermissions --dangerously-skip-permissions)
  else
    perm_flags=(--permission-mode "$PERMISSION_MODE")
  fi

  echo ""
  echo "=== $label ==="
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] cd $dir && claude -p <task> --output-format json --model $MODEL --max-budget-usd $MAX_BUDGET ${perm_flags[*]} ${extra_flags[*]}"
    printf '%s' '{"type":"result","subtype":"dry_run","is_error":false,"duration_ms":0,"num_turns":0,"result":"(dry run)","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}' > "$json_out"
    echo "0" > "$RESULTS_DIR/$label.seconds"
    : > "$RESULTS_DIR/$label.diffstat"
    return
  fi

  local start end elapsed status=0
  start=$(date +%s.%N)
  set +e
  ( cd "$dir" && timeout "$TIMEOUT_SECONDS" claude -p "$TASK" \
      --output-format json \
      --model "$MODEL" \
      --max-budget-usd "$MAX_BUDGET" \
      "${perm_flags[@]}" \
      "${extra_flags[@]}" ) > "$json_out" 2> "$log_out"
  status=$?
  set -e
  end=$(date +%s.%N)
  elapsed=$(node -e "console.log((${end} - ${start}).toFixed(2))")
  echo "$elapsed" > "$RESULTS_DIR/$label.seconds"

  if [[ "$status" -ne 0 ]]; then
    echo "claude exited with status $status for $label (see $log_out)" >&2
  fi

  # Stage everything (including new files) so the diff captures the full result.
  git -C "$dir" add -A
  git -C "$dir" diff --cached --stat > "$RESULTS_DIR/$label.diffstat" || true
  git -C "$dir" diff --cached > "$RESULTS_DIR/$label.diff" || true
}

run_variant "with-skills" "$WITH_DIR"
run_variant "without-skills" "$WITHOUT_DIR" --disable-slash-commands

node "$SCRIPT_DIR/bench-report.mjs" "$RESULTS_DIR"

if [[ "$KEEP" -eq 1 ]]; then
  echo ""
  echo "Worktrees kept at:"
  echo "  $WITH_DIR"
  echo "  $WITHOUT_DIR"
fi
