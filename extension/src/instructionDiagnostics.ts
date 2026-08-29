import * as fs from "node:fs";
import * as path from "node:path";
import { analyzeRejectionReasons, readRecommendationFeedback, readProposalOutcomes } from "./proposalOutcome";
import { validateInstructionFile } from "./copilotTransform";
import { loadManifest, Manifest, SkillRule } from "./skillOps";

export interface SkillAdoptionDiagnostics {
  skillName: string;
  adoptionStatus: "high" | "medium" | "low" | "zero";
  adoptionRate: number; // percentage (0-100)
  proposalCount: number;
  invocationCount: number;
  rejectionReasons: Record<string, number>;
  instructionValid: boolean;
  instructionWarnings: string[];
  detectGlobsCount: number;
  description: string;
  recommendations: string[];
}

export interface CopilotDiagnosticsReport {
  timestamp: string;
  workspaceRoot: string;
  skillCount: number;
  adoptedSkills: string[];
  zeroAdoptionSkills: string[];
  skillDiagnostics: SkillAdoptionDiagnostics[];
  overallHealth: "healthy" | "degraded" | "critical";
  systemRecommendations: string[];
}

/**
 * Analyze the adoption and health of Copilot instructions across all skills.
 * Returns detailed diagnostics to help identify and fix zero-adoption skills.
 */
export function diagnoseCopilotAdoption(target: string, libraryDir: string): CopilotDiagnosticsReport {
  const manifest = loadManifest(libraryDir);
  const feedback = readRecommendationFeedback(target);
  const outcomes = readProposalOutcomes(target);
  const instructionsDir = path.join(target, ".github", "instructions");

  const skillDiagnostics: SkillAdoptionDiagnostics[] = [];
  const adoptedSkills: string[] = [];
  const zeroAdoptionSkills: string[] = [];

  // Build invocation counts from proposal outcomes
  const invocationCounts: Record<string, number> = {};
  const proposalCounts: Record<string, number> = {};

  for (const outcome of outcomes) {
    for (const skill of outcome.proposed || []) {
      proposalCounts[skill] = (proposalCounts[skill] || 0) + 1;
    }
    for (const skill of outcome.invoked || []) {
      invocationCounts[skill] = (invocationCounts[skill] || 0) + 1;
    }
  }

  // Build rejection reason counts. Every recommendation-feedback.jsonl record is a
  // rejection by construction (accepted proposals never reach this file) — no accepted
  // check needed here.
  const rejectionCounts: Record<string, Record<string, number>> = {};
  for (const f of feedback) {
    if (!rejectionCounts[f.skill]) {
      rejectionCounts[f.skill] = {};
    }
    rejectionCounts[f.skill][f.reason] = (rejectionCounts[f.skill][f.reason] || 0) + 1;
  }

  // Analyze each skill
  for (const [skillName, skillMeta] of Object.entries(manifest.skills || {}) as Array<[string, SkillRule]>) {
    const proposalCount = proposalCounts[skillName] || 0;
    const invocationCount = invocationCounts[skillName] || 0;
    const adoptionRate = proposalCount > 0 ? Math.round((invocationCount / proposalCount) * 100) : 0;

    let adoptionStatus: "high" | "medium" | "low" | "zero";
    if (adoptionRate === 0 && proposalCount > 3) {
      adoptionStatus = "zero";
      zeroAdoptionSkills.push(skillName);
    } else if (adoptionRate >= 50) {
      adoptionStatus = "high";
      adoptedSkills.push(skillName);
    } else if (adoptionRate >= 20) {
      adoptionStatus = "medium";
    } else {
      adoptionStatus = "low";
    }

    // Check instruction file validity
    const instructionPath = path.join(instructionsDir, `${skillName}.instructions.md`);
    let instructionValid = false;
    let instructionWarnings: string[] = [];
    const detectGlobsCount = skillMeta.detect_globs?.length || 0;

    if (fs.existsSync(instructionPath)) {
      const validation = validateInstructionFile(
        instructionPath,
        skillName,
        skillMeta.detect_globs || []
      );
      instructionValid = validation.valid;
      instructionWarnings = validation.warnings;
    }

    // Generate recommendations for improving adoption
    const recommendations: string[] = [];

    if (adoptionStatus === "zero" && proposalCount > 3) {
      recommendations.push("Skill is never adopted despite being proposed — consider improving the description or expanding detect_globs");
      
      const rejections = rejectionCounts[skillName] || {};
      const topRejection = Object.entries(rejections).sort((a, b) => b[1] - a[1])[0];
      if (topRejection) {
        const reason = topRejection[0];
        const count = topRejection[1];
        
        if (reason === "ignored" && count > 3) {
          recommendations.push(`Most rejections are "ignored" (${count}x) — the skill description may not match user needs`);
        } else if (reason === "not_relevant" || reason === "wrong_domain") {
          recommendations.push(`Skill is often seen as irrelevant — verify detect_globs match actual use cases`);
        } else if (reason === "misleading_description") {
          recommendations.push(`Users report misleading description — update to be more accurate and specific`);
        }
      }
    }

    if (detectGlobsCount > 20) {
      recommendations.push(`High pattern count (${detectGlobsCount}) — consider if all patterns are necessary`);
    } else if (detectGlobsCount === 0 || !skillMeta.detect_globs?.length) {
      recommendations.push("Skill matches all files (**/*) — consider narrowing detect_globs for better precision");
    }

    if (!instructionValid || instructionWarnings.length > 0) {
      recommendations.push(`Instruction file issues detected — ${instructionWarnings.length} warnings`);
    }

    skillDiagnostics.push({
      skillName,
      adoptionStatus,
      adoptionRate,
      proposalCount,
      invocationCount,
      rejectionReasons: rejectionCounts[skillName] || {},
      instructionValid,
      instructionWarnings,
      detectGlobsCount,
      description: skillMeta.description || "No description",
      recommendations,
    });
  }

  // Sort by adoption rate (lowest first for easier review)
  skillDiagnostics.sort((a, b) => a.adoptionRate - b.adoptionRate);

  // Generate system recommendations
  const systemRecommendations: string[] = [];
  const healthyRate = adoptedSkills.length / (manifest.skills ? Object.keys(manifest.skills).length : 1);

  if (zeroAdoptionSkills.length > 0) {
    systemRecommendations.push(
      `${zeroAdoptionSkills.length} skills have zero adoption. Review their detect_globs and descriptions.`
    );
  }

  if (healthyRate < 0.3) {
    systemRecommendations.push(
      "Less than 30% of skills are actively adopted. Consider reviewing skill triggers and descriptions."
    );
  }

  const overallHealth = zeroAdoptionSkills.length > 5 ? "critical" : zeroAdoptionSkills.length > 0 ? "degraded" : "healthy";

  return {
    timestamp: new Date().toISOString(),
    workspaceRoot: target,
    skillCount: manifest.skills ? Object.keys(manifest.skills).length : 0,
    adoptedSkills,
    zeroAdoptionSkills,
    skillDiagnostics,
    overallHealth,
    systemRecommendations,
  };
}

/**
 * Format diagnostics report as readable text for CLI output.
 */
export function formatDiagnosticsReport(report: CopilotDiagnosticsReport): string {
  const lines: string[] = [];

  lines.push("╔════════════════════════════════════════════════════════════════╗");
  lines.push("║         COPILOT INSTRUCTION ADOPTION DIAGNOSTICS REPORT       ║");
  lines.push("╚════════════════════════════════════════════════════════════════╝");
  lines.push("");
  lines.push(`Timestamp:  ${report.timestamp}`);
  lines.push(`Workspace:  ${report.workspaceRoot}`);
  lines.push(`Overall Health: ${report.overallHealth.toUpperCase()}`);
  lines.push("");

  lines.push("📊 ADOPTION SUMMARY");
  lines.push(`   Total Skills:        ${report.skillCount}`);
  lines.push(`   Adopted (≥50%):      ${report.adoptedSkills.length}`);
  lines.push(`   Zero Adoption:       ${report.zeroAdoptionSkills.length}`);
  lines.push("");

  if (report.zeroAdoptionSkills.length > 0) {
    lines.push("⚠️  ZERO-ADOPTION SKILLS");
    for (const skillName of report.zeroAdoptionSkills) {
      const diag = report.skillDiagnostics.find((d) => d.skillName === skillName);
      if (diag) {
        lines.push(`   • ${skillName}`);
        lines.push(`     Proposed ${diag.proposalCount}x, invoked ${diag.invocationCount}x (${diag.adoptionRate}%)`);
        if (diag.recommendations.length > 0) {
          lines.push(`     Recommendations:`);
          for (const rec of diag.recommendations) {
            lines.push(`       - ${rec}`);
          }
        }
      }
    }
    lines.push("");
  }

  if (report.systemRecommendations.length > 0) {
    lines.push("💡 SYSTEM RECOMMENDATIONS");
    for (const rec of report.systemRecommendations) {
      lines.push(`   • ${rec}`);
    }
    lines.push("");
  }

  lines.push("📋 DETAILED SKILL ANALYSIS");
  lines.push("");
  for (const skill of report.skillDiagnostics) {
    const statusEmoji = skill.adoptionStatus === "zero" ? "❌" : skill.adoptionStatus === "low" ? "⚠️ " : "✅";
    lines.push(`${statusEmoji} ${skill.skillName}`);
    lines.push(`   Adoption: ${skill.adoptionRate}% (${skill.invocationCount}/${skill.proposalCount})`);
    lines.push(`   Patterns: ${skill.detectGlobsCount}`);
    lines.push(`   Instruction File: ${skill.instructionValid ? "✓ Valid" : "✗ Invalid"}`);
    if (skill.instructionWarnings.length > 0) {
      lines.push(`   Warnings: ${skill.instructionWarnings.join("; ")}`);
    }
    if (Object.keys(skill.rejectionReasons).length > 0) {
      const topReason = Object.entries(skill.rejectionReasons).sort((a, b) => b[1] - a[1])[0];
      if (topReason) {
        lines.push(`   Top Rejection: ${topReason[0]} (${topReason[1]}x)`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
