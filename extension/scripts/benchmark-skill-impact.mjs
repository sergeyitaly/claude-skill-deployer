#!/usr/bin/env node
/**
 * Cross-platform skill impact benchmark (Windows + POSIX).
 * Compares Claude CLI with skills vs --disable-slash-commands in disposable git worktrees.
 *
 * Usage:
 *   node scripts/benchmark-skill-impact.mjs [options]
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(scriptDir, "..");

function gitRoot() {
  const r = spawnSync("git", ["-C", scriptDir, "rev-parse", "--show-toplevel"], {
    encoding: "utf-8",
  });
  if (r.status !== 0) {
    throw new Error("Not inside a git repository (required for worktrees).");
  }
  return r.stdout.trim();
}

function usage() {
  console.log(`Usage: benchmark-skill-impact.mjs [options]

Runs the same task twice via the Claude Code CLI in two disposable git
worktrees: once with skills (default), once with --disable-slash-commands.
Writes a markdown report under extension/scripts/bench-results/<run-id>/.

Options:
  --task "<prompt>"       Inline task prompt
  --task-file <path>      Task file (default: scripts/bench-tasks/default-task.md)
  --model <name>          Model alias (default: sonnet)
  --permission-mode <m>   Permission mode (default: acceptEdits)
  --unattended            bypassPermissions + dangerously-skip-permissions
  --max-budget-usd <n>    Per-run spend cap (default: 2.00)
  --timeout <seconds>     Per-run timeout (default: 300)
  --keep                  Keep worktrees after run
  --dry-run               Print commands only
  -h, --help              Show help
`);
}

function parseArgs(argv) {
  const opts = {
    task: "",
    taskFile: "",
    model: "sonnet",
    permissionMode: "acceptEdits",
    unattended: false,
    maxBudget: "2.00",
    timeoutSeconds: 300,
    keep: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case "--task":
        opts.task = argv[++i] ?? "";
        break;
      case "--task-file":
        opts.taskFile = argv[++i] ?? "";
        break;
      case "--model":
        opts.model = argv[++i] ?? opts.model;
        break;
      case "--permission-mode":
        opts.permissionMode = argv[++i] ?? opts.permissionMode;
        break;
      case "--unattended":
        opts.unattended = true;
        break;
      case "--max-budget-usd":
        opts.maxBudget = argv[++i] ?? opts.maxBudget;
        break;
      case "--timeout":
        opts.timeoutSeconds = Number(argv[++i] ?? opts.timeoutSeconds);
        break;
      case "--keep":
        opts.keep = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "-h":
      case "--help":
        usage();
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${a}`);
        usage();
        process.exit(1);
    }
  }
  return opts;
}

function resolveTask(opts) {
  if (opts.task) {
    return opts.task;
  }
  const taskFile = opts.taskFile
    ? path.resolve(process.cwd(), opts.taskFile)
    : path.join(scriptDir, "bench-tasks", "default-task.md");
  if (!fs.existsSync(taskFile)) {
    throw new Error(`Task file not found: ${taskFile}`);
  }
  return fs.readFileSync(taskFile, "utf-8").trim();
}

function runGit(repoRoot, args) {
  return spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function cleanupWorktrees(repoRoot, benchRoot, withDir, withoutDir, keep, dryRun) {
  if (keep || dryRun) {
    return;
  }
  runGit(repoRoot, ["worktree", "remove", "--force", withDir]);
  runGit(repoRoot, ["worktree", "remove", "--force", withoutDir]);
  try {
    fs.rmSync(benchRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function runVariant(label, dir, task, opts, extraArgs, resultsDir) {
  const jsonOut = path.join(resultsDir, `${label}.json`);
  const logOut = path.join(resultsDir, `${label}.log`);
  const secondsOut = path.join(resultsDir, `${label}.seconds`);
  const diffstatOut = path.join(resultsDir, `${label}.diffstat`);
  const diffOut = path.join(resultsDir, `${label}.diff`);

  const permArgs = opts.unattended
    ? ["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"]
    : ["--permission-mode", opts.permissionMode];

  console.log("");
  console.log(`=== ${label} ===`);

  if (opts.dryRun) {
    console.log(
      `[dry-run] cd ${dir} && claude -p <task> --output-format json --model ${opts.model} --max-budget-usd ${opts.maxBudget} ${[...permArgs, ...extraArgs].join(" ")}`
    );
    fs.writeFileSync(
      jsonOut,
      JSON.stringify({
        type: "result",
        subtype: "dry_run",
        is_error: false,
        duration_ms: 0,
        num_turns: 0,
        result: "(dry run)",
        total_cost_usd: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      })
    );
    fs.writeFileSync(secondsOut, "0");
    fs.writeFileSync(diffstatOut, "");
    return;
  }

  const claudeArgs = [
    "-p",
    task,
    "--output-format",
    "json",
    "--model",
    opts.model,
    "--max-budget-usd",
    opts.maxBudget,
    ...permArgs,
    ...extraArgs,
  ];

  const t0 = performance.now();
  const result = spawnSync("claude", claudeArgs, {
    cwd: dir,
    encoding: "utf-8",
    timeout: opts.timeoutSeconds * 1000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
  fs.writeFileSync(secondsOut, elapsed);

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  fs.writeFileSync(jsonOut, stdout || "{}");
  fs.writeFileSync(logOut, stderr);

  if (result.status !== 0) {
    console.error(`claude exited with status ${result.status ?? "timeout"} for ${label} (see ${logOut})`);
    if (result.error) {
      console.error(result.error.message);
    }
  } else {
    console.log(`Finished in ${elapsed}s`);
  }

  runGit(dir, ["add", "-A"]);
  const diffstat = spawnSync("git", ["-C", dir, "diff", "--cached", "--stat"], {
    encoding: "utf-8",
  });
  fs.writeFileSync(diffstatOut, diffstat.stdout ?? "");
  const diff = spawnSync("git", ["-C", dir, "diff", "--cached"], { encoding: "utf-8" });
  fs.writeFileSync(diffOut, diff.stdout ?? "");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const task = resolveTask(opts);
  const repoRoot = gitRoot();

  if (!opts.dryRun) {
    const whichCmd = process.platform === "win32" ? "where.exe" : "which";
    const which = spawnSync(whichCmd, ["claude"], { encoding: "utf-8" });
    if (which.status !== 0) {
      console.error("claude CLI not found on PATH. Install Claude Code CLI first.");
      process.exit(1);
    }
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const benchRoot = path.join(repoRoot, ".bench-tmp", runId);
  const resultsDir = path.join(scriptDir, "bench-results", runId);
  const withDir = path.join(benchRoot, "with-skills");
  const withoutDir = path.join(benchRoot, "without-skills");

  fs.mkdirSync(resultsDir, { recursive: true });

  console.log(`Run ID: ${runId}`);
  console.log("Task:");
  console.log("---");
  console.log(task);
  console.log("---");

  if (!opts.dryRun) {
    fs.mkdirSync(benchRoot, { recursive: true });
    const w1 = runGit(repoRoot, ["worktree", "add", "--detach", withDir, "HEAD"]);
    if (w1.status !== 0) {
      throw new Error(`git worktree add failed: ${w1.stderr || w1.stdout}`);
    }
    const w2 = runGit(repoRoot, ["worktree", "add", "--detach", withoutDir, "HEAD"]);
    if (w2.status !== 0) {
      throw new Error(`git worktree add failed: ${w2.stderr || w2.stdout}`);
    }
  }

  try {
    runVariant("with-skills", withDir, task, opts, [], resultsDir);
    runVariant("without-skills", withoutDir, task, opts, ["--disable-slash-commands"], resultsDir);

    const report = spawnSync(process.execPath, [path.join(scriptDir, "bench-report.mjs"), resultsDir], {
      encoding: "utf-8",
      stdio: "inherit",
    });
    if (report.status !== 0) {
      process.exit(report.status ?? 1);
    }

    if (opts.keep) {
      console.log("");
      console.log("Worktrees kept at:");
      console.log(`  ${withDir}`);
      console.log(`  ${withoutDir}`);
    }
  } finally {
    cleanupWorktrees(repoRoot, benchRoot, withDir, withoutDir, opts.keep, opts.dryRun);
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
