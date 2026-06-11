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
    message: "Step 1: Install the skill library to your machine (one-time).",
    command: "claudeSkills.installLibraryToGlobal",
    detail: "Copies bundled skills to ~/.claude/skills/",
  },
  {
    message: "Step 2: Detect and install skills relevant to this workspace.",
    command: "claudeSkills.generateForWorkspace",
    detail: "Uses manifest detect_globs against your project files.",
  },
  {
    message: "Step 3: Set a daily budget to control estimated Claude spend.",
    command: "claudeSkills.openBudgetSettings",
    detail: "Settings -> Claude Skills -> Budget",
  },
  {
    message: "Step 4: Explore the Cost Intelligence Dashboard.",
    command: "claudeSkills.showCostDashboard",
    detail: "Top expensive skills, savings opportunities, team attribution.",
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
      break;
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

  await context.globalState.update("claudeSkills.onboardingTourCompleted", true);
  vscode.window.showInformationMessage("Claude Skills onboarding complete. Open the activity bar view anytime.");
}
