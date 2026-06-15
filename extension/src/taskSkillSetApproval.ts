import * as vscode from "vscode";
import { notificationLevel } from "./userNotify";
import {
  markTaskSkillSetSkipped,
  readTaskSkillProposals,
  selectTaskSkillSetOption,
  TaskSkillProposalsFile,
  taskSkillSetApprovalPending,
} from "./taskSkillProposals";
import { taskSkillSetApprovalEnabled } from "./taskFocusConfig";

export interface TaskSkillSetPickItem extends vscode.QuickPickItem {
  optionId: string;
  skillCount: number;
}

export function buildTaskSkillSetPickItems(file: TaskSkillProposalsFile): TaskSkillSetPickItem[] {
  const options = file.options ?? [];
  const items: TaskSkillSetPickItem[] = options.map((option) => {
    const preview = option.skills.slice(0, 4).join(", ");
    const more = option.skills.length > 4 ? ` +${option.skills.length - 4}` : "";
    return {
      optionId: option.id,
      skillCount: option.skills.length,
      label: `${option.label} (${option.skills.length} skills)`,
      description: option.description,
      detail: `${preview}${more}`,
    };
  });
  items.push({
    optionId: "__skip__",
    skillCount: 0,
    label: "Skip for this task",
    description: "Keep current skill focus — do not auto-apply a new set",
  });
  return items;
}

let promptInFlight = false;
let lastPromptedGeneratedAt: string | undefined;

export function resetTaskSkillSetApprovalPromptState(): void {
  promptInFlight = false;
  lastPromptedGeneratedAt = undefined;
}

/** Show skill-set options when approval is pending. Returns true when user approved an option. */
export async function promptTaskSkillSetApproval(
  target: string,
  log: (line: string) => void,
  opts?: { force?: boolean }
): Promise<boolean> {
  if (!taskSkillSetApprovalEnabled()) {
    return false;
  }
  const file = readTaskSkillProposals(target);
  if (!file?.options?.length) {
    return false;
  }
  if (!opts?.force && !taskSkillSetApprovalPending(file)) {
    return false;
  }
  if (notificationLevel() === "silent" && !opts?.force) {
    return false;
  }
  if (promptInFlight) {
    return false;
  }
  if (!opts?.force && file.generatedAt === lastPromptedGeneratedAt) {
    return false;
  }

  promptInFlight = true;
  lastPromptedGeneratedAt = file.generatedAt;
  try {
    const picked = await vscode.window.showQuickPick(buildTaskSkillSetPickItems(file), {
      title: "Choose skill set for this task",
      placeHolder: file.taskSummary || "Pick how many skills to keep active for this task",
      ignoreFocusOut: true,
    });
    if (!picked) {
      lastPromptedGeneratedAt = undefined;
      return false;
    }
    if (picked.optionId === "__skip__") {
      markTaskSkillSetSkipped(target);
      log("Task skill set approval skipped — current focus unchanged.");
      return false;
    }
    const updated = selectTaskSkillSetOption(target, picked.optionId);
    if (!updated) {
      return false;
    }
    log(`Task skill set approved: ${picked.label}.`);
    return true;
  } finally {
    promptInFlight = false;
  }
}

export async function maybePromptTaskSkillSetApproval(
  target: string,
  log: (line: string) => void
): Promise<boolean> {
  return promptTaskSkillSetApproval(target, log);
}
