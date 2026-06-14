import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  Uri: {
    file: (p: string) => ({ fsPath: p }),
  },
  workspace: {
    getWorkspaceFolder: () => undefined,
    getConfiguration: (section: string) => ({
      get: <T>(key: string, defaultValue: T): T => {
        if (section === "claudeSkills.features" && key === "sessionSkillAdaptation") {
          return false as T;
        }
        if (section === "claudeSkills.agents" && key === "enabled") {
          return ["claude", "cursor"] as T;
        }
        return defaultValue;
      },
      inspect: <T>(key: string) => {
        if (key === "lockedTier") {
          return {
            key,
            defaultValue: "" as T,
            globalValue: undefined,
            workspaceValue: undefined,
            workspaceFolderValue: undefined,
          };
        }
        return undefined;
      },
      update: async () => undefined,
    }),
  },
  ConfigurationTarget: { Workspace: 2, WorkspaceFolder: 3 },
}));

import { buildCliConfig, syncCliConfigToWorkspace } from "./cliConfig";

describe("cliConfig", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) {
      fs.rmSync(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it("writes cli-config.json with feature toggles and enabled agents", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "cli-config-"));
    dirs.push(target);
    const libraryDir = path.join(__dirname, "..", "skills_library");

    const config = syncCliConfigToWorkspace(target, libraryDir);
    expect(config.version).toBe(1);
    expect(config.features.sessionSkillAdaptation).toBe(false);
    expect(config.agents.enabled).toEqual(["claude", "cursor"]);

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(target, ".claude", "learning", "cli-config.json"), "utf-8")
    );
    expect(onDisk.updatedBy).toBe("extension");
  });

  it("buildCliConfig includes all default feature keys", () => {
    const libraryDir = path.join(__dirname, "..", "skills_library");
    const config = buildCliConfig(libraryDir);
    expect(config.features.branchProfiles).toBe(true);
    expect(config.features.multiAgent).toBe(true);
  });
});
