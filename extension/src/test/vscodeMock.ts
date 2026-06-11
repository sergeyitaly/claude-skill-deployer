/** Minimal stub so unit tests can import modules that reference `vscode`. */
export const workspace = {
  getConfiguration: () => ({
    get: () => undefined,
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
