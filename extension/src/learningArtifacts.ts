import * as fs from "node:fs";
import * as path from "node:path";
import { readRunRecords } from "./usageStats";

const LEARNING_DIR = path.join(".claude", "learning");

function write(target: string, name: string, body: string): void {
  try {
    const file = path.join(target, LEARNING_DIR, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body.endsWith("\n") ? body : `${body}\n`, "utf-8");
  } catch { /* learning artifacts are best effort */ }
}

/** Materialize the Markdown artifacts promised by the self-learning skill. */
export function refreshLearningArtifacts(target: string): void {
  const runs = readRunRecords(target);
  const bySkill = new Map<string, { runs: number; successes: number }>();
  for (const run of runs) {
    const row = bySkill.get(run.skill) ?? { runs: 0, successes: 0 };
    row.runs++;
    if (run.success) row.successes++;
    bySkill.set(run.skill, row);
  }
  const lines = ["# Learned Patterns", "", `Generated: ${new Date().toISOString()}`, "", "## Skill outcomes", ""];
  if (bySkill.size === 0) lines.push("No skill outcomes recorded yet.", "");
  for (const [skill, row] of [...bySkill.entries()].sort()) {
    lines.push(`- **${skill}**: ${row.successes}/${row.runs} successful (${Math.round(row.successes / row.runs * 100)}%)`);
  }
  write(target, "patterns.md", lines.join("\n"));

  const cache = path.join(target, LEARNING_DIR, "knowledge-cache.md");
  if (!fs.existsSync(cache)) {
    write(target, "knowledge-cache.md", "# Knowledge Cache\n\nAdd explicit, verified question-and-answer learnings here.\n");
  }
  const feedback = path.join(target, LEARNING_DIR, "skill-feedback.jsonl");
  if (!fs.existsSync(feedback)) write(target, "skill-feedback.jsonl", "");
}
