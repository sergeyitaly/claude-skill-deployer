import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runsFilePath } from "./runsStore";
import { invalidateLearningCache } from "./runsStore";

/** Reconciles Cursor's blended cost estimates against a CSV exported from the Cursor dashboard (Settings -> Usage -> Export). */

export const CURSOR_RECONCILED_COST_METHOD = "reconciled";
export const CURSOR_RECONCILED_SOURCE = "cursor-dashboard-csv";

export interface CursorCsvRow {
  /** YYYY-MM-DD (UTC) */
  date: string;
  costUsd: number;
}

export interface CursorCsvParseResult {
  headers: string[];
  rows: CursorCsvRow[];
}

const DATE_HEADER_CANDIDATES = ["date", "timestamp", "created at", "createdat", "time"];
const COST_HEADER_CANDIDATES = ["cost", "cost ($)", "cost (usd)", "total cost", "amount", "price", "spend"];

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells.map((c) => c.trim());
}

function findColumn(headers: string[], candidates: string[]): number {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const candidate of candidates) {
    const idx = lower.indexOf(candidate);
    if (idx >= 0) {
      return idx;
    }
  }
  for (let i = 0; i < lower.length; i++) {
    if (candidates.some((c) => lower[i].includes(c))) {
      return i;
    }
  }
  return -1;
}

/** Accepts ISO timestamps ("2026-06-10T12:00:00Z") or any `Date`-parseable string; returns the UTC date portion. */
function parseDateCell(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const isoMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) {
    return isoMatch[1];
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString().slice(0, 10);
}

function parseCostCell(raw: string): number {
  const cleaned = raw.replace(/[^0-9.-]/g, "");
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

export function parseCursorUsageCsv(content: string): CursorCsvParseResult {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }
  const headers = splitCsvLine(lines[0]);
  const dateIdx = findColumn(headers, DATE_HEADER_CANDIDATES);
  const costIdx = findColumn(headers, COST_HEADER_CANDIDATES);
  if (dateIdx < 0 || costIdx < 0) {
    return { headers, rows: [] };
  }

  const rows: CursorCsvRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const date = parseDateCell(cells[dateIdx] ?? "");
    if (!date) {
      continue;
    }
    rows.push({ date, costUsd: parseCostCell(cells[costIdx] ?? "") });
  }
  return { headers, rows };
}

export interface CursorReconcileResult {
  csvRows: number;
  csvTotalUsd: number;
  /** Calendar dates (UTC) present in the CSV that have at least one matching `cursor` run in runs.jsonl. */
  matchedDates: string[];
  /** Calendar dates present in the CSV with no matching `cursor` runs (e.g. usage outside this workspace). */
  unmatchedCsvDates: string[];
  rowsUpdated: number;
  estimatedTotalUsd: number;
  reconciledTotalUsd: number;
}

/**
 * Rewrites `cost` for `cursor` rows in this workspace's runs.jsonl so each day's total matches the
 * actual per-day total from the Cursor dashboard CSV, redistributed proportionally to the existing
 * (blended-estimate) per-run costs. Marks updated rows with `metadata.cost_method = "reconciled"`.
 */
export function reconcileCursorCosts(target: string, csvContent: string): CursorReconcileResult {
  const { headers, rows } = parseCursorUsageCsv(csvContent);
  if (rows.length === 0) {
    throw new Error(
      `Could not find date/cost columns in this CSV. Headers found: ${headers.length > 0 ? headers.join(", ") : "(empty file)"}`
    );
  }

  const actualByDate = new Map<string, number>();
  for (const row of rows) {
    actualByDate.set(row.date, (actualByDate.get(row.date) ?? 0) + row.costUsd);
  }
  const csvTotalUsd = [...actualByDate.values()].reduce((sum, v) => sum + v, 0);

  const file = runsFilePath(target);
  const rawLines = fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf-8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    : [];

  const records: (Record<string, unknown> | null)[] = rawLines.map((line) => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }
  });

  const entriesByDate = new Map<string, { idx: number; cost: number }[]>();
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (!row || row.agent !== "cursor") {
      continue;
    }
    const ts = (row.ts ?? row.timestamp) as string | undefined;
    if (!ts) {
      continue;
    }
    const date = ts.slice(0, 10);
    if (!actualByDate.has(date)) {
      continue;
    }
    const cost = typeof row.cost === "number" ? row.cost : 0;
    const arr = entriesByDate.get(date) ?? [];
    arr.push({ idx: i, cost });
    entriesByDate.set(date, arr);
  }

  let rowsUpdated = 0;
  let estimatedTotalUsd = 0;
  let reconciledTotalUsd = 0;
  const reconciledAt = new Date().toISOString();

  for (const [date, entries] of entriesByDate) {
    const actual = actualByDate.get(date) ?? 0;
    const estimated = entries.reduce((sum, e) => sum + e.cost, 0);
    estimatedTotalUsd += estimated;

    for (const entry of entries) {
      const share = estimated > 0 ? entry.cost / estimated : 1 / entries.length;
      const newCost = actual * share;
      reconciledTotalUsd += newCost;

      const row = records[entry.idx]!;
      const metadata = (row.metadata as Record<string, unknown> | undefined) ?? {};
      metadata.pre_reconcile_cost = entry.cost;
      metadata.cost_method = CURSOR_RECONCILED_COST_METHOD;
      metadata.reconciled_from = CURSOR_RECONCILED_SOURCE;
      metadata.reconciled_at = reconciledAt;
      row.metadata = metadata;
      row.cost = newCost;
      rowsUpdated += 1;
    }
  }

  if (rowsUpdated > 0) {
    const out = records.map((row, i) => (row ? JSON.stringify(row) : rawLines[i]));
    fs.writeFileSync(file, out.join("\n") + "\n", "utf-8");
    invalidateLearningCache(target);
  }

  const matchedDates = [...entriesByDate.keys()].sort();
  const unmatchedCsvDates = [...actualByDate.keys()].filter((d) => !entriesByDate.has(d)).sort();

  return {
    csvRows: rows.length,
    csvTotalUsd,
    matchedDates,
    unmatchedCsvDates,
    rowsUpdated,
    estimatedTotalUsd,
    reconciledTotalUsd,
  };
}

export const DEFAULT_CURSOR_CSV_WATCH_DIR = path.join(os.homedir(), "Downloads");

function importStatePath(target: string): string {
  return path.join(target, ".claude", "learning", "cursor-usage-import-state.json");
}

interface CursorImportState {
  /** Absolute file path -> mtime (ms) at the time it was last reconciled. */
  processedFiles?: Record<string, number>;
}

function readImportState(target: string): CursorImportState {
  try {
    return JSON.parse(fs.readFileSync(importStatePath(target), "utf-8")) as CursorImportState;
  } catch {
    return {};
  }
}

function writeImportState(target: string, state: CursorImportState): void {
  const file = importStatePath(target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

export interface CursorAutoReconcileEntry {
  file: string;
  result: CursorReconcileResult;
}

/**
 * Silently scans `watchDir` (default: OS Downloads folder) for Cursor usage-export CSVs that
 * haven't been reconciled yet, and reconciles each one against this workspace's runs.jsonl.
 * A file is treated as a Cursor usage export when its name mentions "cursor"/"usage" and its
 * content has parseable date/cost columns (see `parseCursorUsageCsv`). Already-processed files
 * (by path + mtime) are skipped on subsequent calls.
 */
export function autoReconcileCursorCostsFromDownloads(
  target: string,
  watchDir: string = DEFAULT_CURSOR_CSV_WATCH_DIR
): CursorAutoReconcileEntry[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(watchDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const state = readImportState(target);
  const processed = state.processedFiles ?? {};
  const results: CursorAutoReconcileEntry[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".csv")) {
      continue;
    }
    if (!/cursor|usage/i.test(entry.name)) {
      continue;
    }
    const filePath = path.join(watchDir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (processed[filePath] === stat.mtimeMs) {
      continue;
    }

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { rows } = parseCursorUsageCsv(content);
    if (rows.length === 0) {
      continue;
    }

    try {
      const result = reconcileCursorCosts(target, content);
      processed[filePath] = stat.mtimeMs;
      results.push({ file: filePath, result });
    } catch {
      continue;
    }
  }

  if (results.length > 0) {
    state.processedFiles = processed;
    writeImportState(target, state);
  }

  return results;
}
