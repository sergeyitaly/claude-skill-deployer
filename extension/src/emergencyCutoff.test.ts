import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, defaultValue?: unknown) => defaultValue,
    }),
  },
}));

let mockedHome = os.tmpdir();
// Isolates the legacy machine-wide fallback path from this machine's real
// ~/.claude/learning/emergency-state.json — without this, a genuinely active real cutoff
// leaks into every test via the fallback and makes results depend on this machine's state.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockedHome };
});

const workspaces: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csd-emergency-"));
  workspaces.push(dir);
  return dir;
}

function legacyStatePath(): string {
  return path.join(mockedHome, ".claude", "learning", "emergency-state.json");
}

function writeProjectState(target: string, state: Record<string, unknown>): void {
  const file = path.join(target, ".claude", "learning", "emergency-state.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

function writeLegacyState(state: Record<string, unknown>): void {
  const file = legacyStatePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

beforeEach(() => {
  mockedHome = fs.mkdtempSync(path.join(os.tmpdir(), "csd-emergency-home-"));
  workspaces.push(mockedHome);
  vi.resetModules();
});

afterEach(() => {
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

describe("getActiveEmergencyCutoffReminder / formatEmergencyCutoffReminderText — per project", () => {
  it("returns null when cutoff is not active for this project", async () => {
    const { getActiveEmergencyCutoffReminder } = await import("./emergencyCutoff");
    const target = makeWorkspace();
    writeProjectState(target, { active: false });
    expect(getActiveEmergencyCutoffReminder(target)).toBeNull();
  });

  it("computes days-since-triggered and formats singular/plural correctly", async () => {
    const { getActiveEmergencyCutoffReminder, formatEmergencyCutoffReminderText } = await import(
      "./emergencyCutoff"
    );
    const target = makeWorkspace();
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000 - 1000).toISOString();
    writeProjectState(target, {
      active: true,
      triggeredAt: oneDayAgo,
      costUsd: 12.5,
      disabledSkills: ["mcp-builder"],
    });

    const reminder = getActiveEmergencyCutoffReminder(target);
    expect(reminder).toEqual({ daysSinceTriggered: 1, costUsd: 12.5, disabledCount: 1 });

    const text = formatEmergencyCutoffReminderText(reminder!);
    expect(text).toContain("1 day ago");
    expect(text).toContain("$12.50");
    expect(text).toContain("1 skill(s) forced off");
    expect(text).toContain("claudeSkills.resetEmergencyCutoff");
  });

  it("uses plural 'days' for multi-day cutoffs and reflects skill count", async () => {
    const { getActiveEmergencyCutoffReminder, formatEmergencyCutoffReminderText } = await import(
      "./emergencyCutoff"
    );
    const target = makeWorkspace();
    const weeksAgo = new Date(Date.now() - 33 * 24 * 60 * 60 * 1000).toISOString();
    writeProjectState(target, {
      active: true,
      triggeredAt: weeksAgo,
      costUsd: 126.8,
      disabledSkills: ["a", "b", "c"],
    });

    const reminder = getActiveEmergencyCutoffReminder(target);
    expect(reminder?.daysSinceTriggered).toBe(33);
    expect(reminder?.disabledCount).toBe(3);

    const text = formatEmergencyCutoffReminderText(reminder!);
    expect(text).toContain("33 days ago");
    expect(text).toContain("3 skill(s) forced off");
  });
});

describe("emergency cutoff is project-scoped, not machine-wide", () => {
  it("a cutoff active in project A is not visible in project B", async () => {
    const { getActiveEmergencyCutoffReminder, isEmergencyCutoffActive } = await import("./emergencyCutoff");
    const projectA = makeWorkspace();
    const projectB = makeWorkspace();
    writeProjectState(projectA, {
      active: true,
      triggeredAt: new Date().toISOString(),
      costUsd: 20,
      disabledSkills: ["heavy-skill"],
    });

    expect(isEmergencyCutoffActive(projectA)).toBe(true);
    expect(isEmergencyCutoffActive(projectB)).toBe(false);
    expect(getActiveEmergencyCutoffReminder(projectB)).toBeNull();
  });

  it("falls back to a pre-existing legacy machine-wide cutoff when this project has no state of its own", async () => {
    const { getActiveEmergencyCutoffReminder } = await import("./emergencyCutoff");
    const target = makeWorkspace();
    writeLegacyState({
      active: true,
      triggeredAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      costUsd: 126.8,
      disabledSkills: ["self-learning"],
    });

    const reminder = getActiveEmergencyCutoffReminder(target);
    expect(reminder).not.toBeNull();
    expect(reminder?.disabledCount).toBe(1);
  });
});
