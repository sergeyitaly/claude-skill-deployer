import * as fs from "node:fs";
import * as path from "node:path";

const WINDOW_MS = 30 * 60 * 1000;
const MAX_APPLIES_PER_WINDOW = 3;

interface RateState {
  windowStart: number;
  count: number;
}

function statePath(target: string): string {
  return path.join(target, ".claude", "learning", "auto-optimizer-state.json");
}

function readState(target: string): RateState {
  try {
    return JSON.parse(fs.readFileSync(statePath(target), "utf-8")) as RateState;
  } catch {
    return { windowStart: 0, count: 0 };
  }
}

function writeState(target: string, state: RateState): void {
  fs.mkdirSync(path.dirname(statePath(target)), { recursive: true });
  fs.writeFileSync(statePath(target), JSON.stringify(state, null, 2) + "\n", "utf-8");
}

export function autoApplySlotsRemaining(target: string, now = Date.now()): number {
  const state = readState(target);
  if (now - state.windowStart >= WINDOW_MS) {
    return MAX_APPLIES_PER_WINDOW;
  }
  return Math.max(0, MAX_APPLIES_PER_WINDOW - state.count);
}

export function recordAutoApplies(target: string, appliedCount: number, now = Date.now()): void {
  if (appliedCount <= 0) {
    return;
  }
  let state = readState(target);
  if (now - state.windowStart >= WINDOW_MS) {
    state = { windowStart: now, count: 0 };
  }
  state.count += appliedCount;
  writeState(target, state);
}
