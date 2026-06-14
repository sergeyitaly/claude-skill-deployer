/** Minimal vscode stub for node smoke tests loading extension out/*.js */
const Module = require("node:module");
const originalLoad = Module._load;

const stub = {
  workspace: {
    getConfiguration: (section) => ({
      get: (key, defaultValue) => {
        if (section === "claudeSkills.agents" && key === "enabled") {
          return ["claude", "cursor", "kiro", "copilot"];
        }
        if (section === "claudeSkills.agents" && key === "syncWorkspaceToAll") {
          return true;
        }
        if (section === "claudeSkills.features" && key === "multiAgent") {
          return true;
        }
        if (section === "claudeSkills.search" && key === "sortBy") {
          return "relevance";
        }
        return defaultValue;
      },
      update: async () => undefined,
    }),
    workspaceFolders: undefined,
    fs: {
      readFile: async () => new Uint8Array(),
      writeFile: async () => undefined,
      stat: async () => ({ type: 1, size: 0, mtime: 0, ctime: 0 }),
    },
  },
  window: {
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    state: { focused: true },
  },
  Uri: { file: (p) => ({ fsPath: p, toString: () => p }) },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  TreeItemCheckboxState: { Checked: 1, Unchecked: 0 },
  ThemeIcon: class {
    constructor(id) {
      this.id = id;
    }
  },
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  },
  EventEmitter: class {
    event() {
      return () => undefined;
    }
    fire() {}
  },
  TreeItem: class {},
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  MarkdownString: class {
    appendMarkdown() {}
  },
};

Module._load = function (request, parent, isMain) {
  if (request === "vscode") {
    return stub;
  }
  return originalLoad.apply(this, arguments);
};
