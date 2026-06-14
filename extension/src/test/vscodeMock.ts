/** Minimal stub so unit tests can import modules that reference `vscode`. */
export const workspace = {
  getWorkspaceFolder: () => undefined,
  getConfiguration: (_section?: string) => ({
    get: <T>(key: string, defaultValue?: T): T | undefined => {
      if (_section === "claudeSkills.agents" && key === "enabled") {
        return ["claude", "cursor", "kiro", "copilot"] as T;
      }
      if (_section === "claudeSkills.lint" && key === "requireFrontmatter") {
        return true as T;
      }
      if (_section === "claudeSkills.agents" && key === "syncWorkspaceToAll") {
        return true as T;
      }
      if (_section === "claudeSkills.features" && key === "multiAgent") {
        return true as T;
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
  workspaceFolders: undefined,
  fs: {
    readFile: async () => new Uint8Array(),
    writeFile: async () => undefined,
    stat: async () => ({ type: 1, size: 0, mtime: 0, ctime: 0 }),
  },
};

export const window = {
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
};

export const Uri = {
  file: (p: string) => ({ fsPath: p, toString: () => p }),
};

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
