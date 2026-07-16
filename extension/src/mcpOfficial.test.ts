import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let mockedHome = os.tmpdir();
// os.homedir() is a native Node built-in — vi.spyOn can't redefine it on the frozen ESM
// module namespace, so the whole module is mocked instead, with a mutable variable each
// test can point at its own scratch "home" directory.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockedHome };
});

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: <T,>(_key: string, defaultValue?: T): T | undefined => defaultValue,
    }),
  },
  window: {
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
  },
}));

const homeDirs: string[] = [];

function makeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csd-mcpofficial-home-"));
  homeDirs.push(dir);
  return dir;
}

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csd-mcpofficial-proj-"));
  homeDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of homeDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  homeDirs.length = 0;
  vi.resetModules();
});

async function loadWithHome(home: string) {
  mockedHome = home;
  vi.resetModules();
  return import("./mcpOfficial");
}

function readAllowedDirsConfig(home: string): { allowedDirs?: string[]; workspaceLogPath?: string } {
  return JSON.parse(
    fs.readFileSync(path.join(home, ".claude", "mcp-servers", "filesystem", "allowed-dirs.json"), "utf-8")
  );
}

describe("allowed-dirs.json — shared across every project on the machine", () => {
  it("activating project B does not revoke project A's previously-granted access (bug reproduction)", async () => {
    const home = makeHome();
    const projectA = makeProject();
    const projectB = makeProject();

    const mod = await loadWithHome(home);
    await mod.ensureCopilotFilesystemConfigReady([projectA], () => {});
    mod.refreshFilesystemAllowedDirs([projectA], () => {});

    let config = readAllowedDirsConfig(home);
    expect(config.allowedDirs).toContain(path.resolve(projectA));

    mod.refreshFilesystemAllowedDirs([projectB], () => {});

    config = readAllowedDirsConfig(home);
    // Project A's access must still be present after project B's activation — previously
    // this was a hard overwrite that dropped it.
    expect(config.allowedDirs).toContain(path.resolve(projectA));
    expect(config.allowedDirs).toContain(path.resolve(projectB));
  });

  it("never duplicates an already-present directory across repeated activations", async () => {
    const home = makeHome();
    const project = makeProject();

    const mod = await loadWithHome(home);
    mod.refreshFilesystemAllowedDirs([project], () => {});
    mod.refreshFilesystemAllowedDirs([project], () => {});
    mod.refreshFilesystemAllowedDirs([project], () => {});

    const config = readAllowedDirsConfig(home);
    const occurrences = config.allowedDirs!.filter((d) => d === path.resolve(project));
    expect(occurrences).toHaveLength(1);
  });

  it("preserves a previously-set workspaceLogPath when a later activation has no folder open", async () => {
    const home = makeHome();
    const project = makeProject();

    const mod = await loadWithHome(home);
    mod.refreshFilesystemAllowedDirs([project], () => {});
    const withProject = readAllowedDirsConfig(home);
    expect(withProject.workspaceLogPath).toContain(path.resolve(project));

    mod.refreshFilesystemAllowedDirs([], () => {});
    const noFolder = readAllowedDirsConfig(home);
    expect(noFolder.workspaceLogPath).toBe(withProject.workspaceLogPath);
  });
});
