import { afterEach, describe, expect, it, vi } from "vitest";

const { showInformationMessage, showWarningMessage } = vi.hoisted(() => ({
  showInformationMessage: vi.fn(async () => undefined),
  showWarningMessage: vi.fn(async () => undefined),
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, defaultValue: string) => defaultValue,
    }),
  },
  window: {
    showInformationMessage,
    showWarningMessage,
  },
}));

import {
  notificationLevel,
  notifyBackground,
  notifySuggestion,
  notifyUserSuccess,
  shouldShowToast,
} from "./userNotify";

describe("userNotify", () => {
  afterEach(() => {
    showInformationMessage.mockClear();
    showWarningMessage.mockClear();
  });

  it("defaults to minimal level", () => {
    expect(notificationLevel()).toBe("minimal");
    expect(shouldShowToast("background")).toBe(false);
    expect(shouldShowToast("suggestion")).toBe(false);
    expect(shouldShowToast("important")).toBe(true);
  });

  it("notifyBackground logs without toasting in minimal mode", () => {
    const lines: string[] = [];
    notifyBackground("synced skills", (m) => lines.push(m));
    expect(lines).toEqual(["synced skills"]);
    expect(showInformationMessage).not.toHaveBeenCalled();
  });

  it("notifySuggestion does not toast in minimal mode", async () => {
    await notifySuggestion("updates available", ["Check"], { dedupeKey: "official-updates" });
    expect(showInformationMessage).not.toHaveBeenCalled();
  });

  it("notifyUserSuccess does not toast in minimal mode", async () => {
    await notifyUserSuccess("installed 3 skills");
    expect(showInformationMessage).not.toHaveBeenCalled();
  });
});
