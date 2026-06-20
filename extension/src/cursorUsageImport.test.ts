import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { autoReconcileCursorCostsFromDownloads, parseCursorUsageCsv, reconcileCursorCosts } from "./cursorUsageImport";
import { runsFilePath } from "./runsStore";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-usage-import-"));
  tempDirs.push(dir);
  return dir;
}

function writeRuns(target: string, lines: Record<string, unknown>[]): void {
  const file = runsFilePath(target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
}

function readRuns(target: string): Record<string, unknown>[] {
  return fs
    .readFileSync(runsFilePath(target), "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseCursorUsageCsv", () => {
  it("parses date and cost columns by header name", () => {
    const csv = ["Date,Model,Cost ($)", "2026-06-10T12:00:00Z,gpt-4,1.23", "2026-06-10T13:00:00Z,gpt-4,2.00"].join(
      "\n"
    );
    const { rows, headers } = parseCursorUsageCsv(csv);
    expect(headers).toEqual(["Date", "Model", "Cost ($)"]);
    expect(rows).toEqual([
      { date: "2026-06-10", costUsd: 1.23 },
      { date: "2026-06-10", costUsd: 2.0 },
    ]);
  });

  it("returns no rows when date/cost columns are not found", () => {
    const csv = ["Foo,Bar", "1,2"].join("\n");
    const { rows } = parseCursorUsageCsv(csv);
    expect(rows).toEqual([]);
  });
});

describe("reconcileCursorCosts", () => {
  it("redistributes the actual daily total proportionally across matching cursor runs", () => {
    const target = makeTempDir();
    writeRuns(target, [
      { ts: "2026-06-10T08:00:00.000Z", skill: "agents", agent: "cursor", cost: 0.02, tokens: 1000 },
      { ts: "2026-06-10T09:00:00.000Z", skill: "docx", agent: "cursor", cost: 0.06, tokens: 3000 },
      { ts: "2026-06-11T08:00:00.000Z", skill: "agents", agent: "claude", cost: 0.5, tokens: 5000 },
    ]);

    const csv = ["Date,Cost ($)", "2026-06-10T10:00:00Z,0.40"].join("\n");
    const result = reconcileCursorCosts(target, csv);

    expect(result.csvRows).toBe(1);
    expect(result.csvTotalUsd).toBeCloseTo(0.4);
    expect(result.matchedDates).toEqual(["2026-06-10"]);
    expect(result.unmatchedCsvDates).toEqual([]);
    expect(result.rowsUpdated).toBe(2);
    expect(result.estimatedTotalUsd).toBeCloseTo(0.08);
    expect(result.reconciledTotalUsd).toBeCloseTo(0.4);

    const rows = readRuns(target);
    const agentsRow = rows.find((r) => r.skill === "agents" && r.agent === "cursor")!;
    const docxRow = rows.find((r) => r.skill === "docx")!;
    const claudeRow = rows.find((r) => r.agent === "claude")!;

    // 0.02/0.08 share of 0.40 = 0.10
    expect(agentsRow.cost as number).toBeCloseTo(0.1);
    // 0.06/0.08 share of 0.40 = 0.30
    expect(docxRow.cost as number).toBeCloseTo(0.3);
    expect((agentsRow.metadata as Record<string, unknown>).cost_method).toBe("reconciled");
    expect((agentsRow.metadata as Record<string, unknown>).reconciled_from).toBe("cursor-dashboard-csv");
    expect((agentsRow.metadata as Record<string, unknown>).pre_reconcile_cost).toBe(0.02);

    // Claude row on a different date is untouched.
    expect(claudeRow.cost).toBe(0.5);
    expect(claudeRow.metadata).toBeUndefined();
  });

  it("reports unmatched CSV dates without changing runs.jsonl", () => {
    const target = makeTempDir();
    writeRuns(target, [{ ts: "2026-06-10T08:00:00.000Z", skill: "agents", agent: "cursor", cost: 0.02 }]);

    const csv = ["Date,Cost ($)", "2026-06-12T10:00:00Z,1.00"].join("\n");
    const result = reconcileCursorCosts(target, csv);

    expect(result.rowsUpdated).toBe(0);
    expect(result.unmatchedCsvDates).toEqual(["2026-06-12"]);
    const rows = readRuns(target);
    expect(rows[0].cost).toBe(0.02);
    expect(rows[0].metadata).toBeUndefined();
  });

  it("throws a helpful error when date/cost columns are missing", () => {
    const target = makeTempDir();
    writeRuns(target, []);
    expect(() => reconcileCursorCosts(target, "Foo,Bar\n1,2")).toThrow(/Could not find date\/cost columns/);
  });

  it("splits the actual total evenly when prior estimates were all zero", () => {
    const target = makeTempDir();
    writeRuns(target, [
      { ts: "2026-06-10T08:00:00.000Z", skill: "agents", agent: "cursor", cost: 0 },
      { ts: "2026-06-10T09:00:00.000Z", skill: "docx", agent: "cursor", cost: 0 },
    ]);

    const csv = ["Date,Cost ($)", "2026-06-10T10:00:00Z,1.00"].join("\n");
    const result = reconcileCursorCosts(target, csv);

    expect(result.rowsUpdated).toBe(2);
    const rows = readRuns(target);
    expect(rows[0].cost as number).toBeCloseTo(0.5);
    expect(rows[1].cost as number).toBeCloseTo(0.5);
  });
});

describe("autoReconcileCursorCostsFromDownloads", () => {
  it("reconciles matching CSVs found in the watch folder and skips unrelated/non-matching files", () => {
    const target = makeTempDir();
    const downloads = makeTempDir();
    writeRuns(target, [{ ts: "2026-06-10T08:00:00.000Z", skill: "agents", agent: "cursor", cost: 0.02 }]);

    fs.writeFileSync(
      path.join(downloads, "cursor-usage-export.csv"),
      ["Date,Cost ($)", "2026-06-10T10:00:00Z,0.10"].join("\n"),
      "utf-8"
    );
    // Not named like a usage export -> ignored even though it has valid columns.
    fs.writeFileSync(path.join(downloads, "other.csv"), ["Date,Cost ($)", "2026-06-10T10:00:00Z,9.99"].join("\n"), "utf-8");
    // Named like a usage export but no parseable date/cost columns -> ignored.
    fs.writeFileSync(path.join(downloads, "usage-notes.csv"), "foo,bar\n1,2", "utf-8");

    const entries = autoReconcileCursorCostsFromDownloads(target, downloads);
    expect(entries).toHaveLength(1);
    expect(entries[0].file).toBe(path.join(downloads, "cursor-usage-export.csv"));
    expect(entries[0].result.rowsUpdated).toBe(1);

    const rows = readRuns(target);
    expect(rows[0].cost as number).toBeCloseTo(0.1);
  });

  it("does not reprocess a file with an unchanged mtime", () => {
    const target = makeTempDir();
    const downloads = makeTempDir();
    writeRuns(target, [{ ts: "2026-06-10T08:00:00.000Z", skill: "agents", agent: "cursor", cost: 0.02 }]);
    fs.writeFileSync(
      path.join(downloads, "cursor-usage-export.csv"),
      ["Date,Cost ($)", "2026-06-10T10:00:00Z,0.10"].join("\n"),
      "utf-8"
    );

    const first = autoReconcileCursorCostsFromDownloads(target, downloads);
    expect(first).toHaveLength(1);

    const second = autoReconcileCursorCostsFromDownloads(target, downloads);
    expect(second).toHaveLength(0);
  });

  it("returns an empty list when the watch folder does not exist", () => {
    const target = makeTempDir();
    const entries = autoReconcileCursorCostsFromDownloads(target, path.join(target, "does-not-exist"));
    expect(entries).toEqual([]);
  });
});
