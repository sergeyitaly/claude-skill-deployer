import * as vscode from "vscode";

interface OnboardingStep {
  message: string;
  command?: string;
  detail?: string;
}

const STEPS: OnboardingStep[] = [
  {
    message: "Welcome to Claude Skills Manager! Set up cost-aware AI assistance in a few steps.",
    detail: "This tour walks through one-time setup and optional budget controls.",
  },
  {
    message: "Step 1: Choose how you use AI agents on this project (solo vs multi-agent).",
    command: "claudeSkills.chooseProjectProfile",
    detail: "Pick TEAM MULTI-AGENT if you use Claude + Cursor + Copilot together.",
  },
  {
    message: "Step 2: Install the skill library to your machine (one-time).",
    command: "claudeSkills.installLibraryToGlobal",
    detail: "Copies bundled skills to ~/.claude/skills/",
  },
  {
    message: "Step 3: Detect and install skills relevant to this workspace.",
    command: "claudeSkills.generateForWorkspace",
    detail: "Uses manifest detect_globs against your project files.",
  },
  {
    message: "Step 4: Set a daily budget to control estimated Claude spend.",
    command: "claudeSkills.openBudgetSettings",
    detail: "Settings -> Claude Skills -> Budget",
  },
  {
    message: "Step 5 (optional): Cost Intelligence Dashboard — needs a few sessions of data.",
    command: "claudeSkills.showCostDashboard",
    detail: "Agent spend first; per-skill breakdown after runs/transcripts accumulate.",
  },
  {
    message: "Optional: Enable cost control hooks for session-size and budget warnings.",
    command: "claudeSkills.installCostControlHooks",
    detail: "Installs UserPromptSubmit hooks into .claude/settings.json",
  },
];

export async function showOnboardingTour(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>("claudeSkills.onboardingTourCompleted", false)) {
    const again = await vscode.window.showInformationMessage(
      "Onboarding tour already completed. Run again?",
      "Yes",
      "No"
    );
    if (again !== "Yes") {
      return;
    }
  }

  for (let i = 0; i < STEPS.length; i++) {
    const step = STEPS[i];
    const label = `Step ${i + 1}/${STEPS.length}`;
    const choice = await vscode.window.showInformationMessage(
      `${label}: ${step.message}`,
      step.command ? "Run step" : "Next",
      "Skip tour",
      "Finish"
    );

    if (choice === "Skip tour") {
      void vscode.window.showInformationMessage(
        "Setup not marked complete. Run Claude Skills: Start Onboarding Tour anytime."
      );
      return;
    }
    if (choice === "Finish") {
      break;
    }
    if (choice === "Run step" && step.command) {
      await vscode.commands.executeCommand(step.command);
    }
    if (step.detail) {
      void vscode.window.setStatusBarMessage(`Claude Skills: ${step.detail}`, 4000);
    }
  }

  const confirm = await vscode.window.showInformationMessage(
    "Mark onboarding as complete?",
    "Yes",
    "Not yet"
  );
  if (confirm === "Yes") {
    await context.globalState.update("claudeSkills.onboardingTourCompleted", true);
    await context.globalState.update("claudeSkills.hasRunBefore", true);
    vscode.window.showInformationMessage("Claude Skills onboarding complete. Open the activity bar view anytime.");
  }
}
