// Validates api query kql files against scripts/adx-schema-setup.kql
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const schemaPath = path.join(root, "scripts", "adx-schema-setup.kql");
const queriesDir = path.join(root, "api", "queries");

function parseSchema(kql) {
  const tables = {};
  const re = /\.create\s+table\s+(\w+)\s*\(([\s\S]*?)\)/gi;
  let m;
  while ((m = re.exec(kql)) !== null) {
    const name = m[1];
    const cols = m[2]
      .split(",")
      .map((line) => line.trim().split(":")[0].trim())
      .filter(Boolean);
    tables[name] = new Set(cols);
  }
  return tables;
}

function firstTableRef(kql) {
  const line = kql
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("//") && !l.startsWith("|"));
  return line?.split(/\s+/)[0] ?? "";
}

function projectColumns(kql) {
  const m = kql.match(/\|\s*project\s+([^|\n]+)/i);
  if (!m) return [];
  return m[1].split(",").map((c) => c.trim());
}

const schema = parseSchema(fs.readFileSync(schemaPath, "utf-8"));
const errors = [];

for (const file of fs.readdirSync(queriesDir).filter((f) => f.endsWith(".kql"))) {
  const full = path.join(queriesDir, file);
  const body = fs.readFileSync(full, "utf-8");
  const table = firstTableRef(body);
  if (!table || !schema[table]) {
    errors.push(`${file}: unknown table '${table}' (schema has: ${Object.keys(schema).join(", ")})`);
    continue;
  }
  for (const col of projectColumns(body)) {
    if (!schema[table].has(col)) {
      errors.push(`${file}: column '${col}' not on table '${table}' (have: ${[...schema[table]].join(", ")})`);
    }
  }
}

if (errors.length) {
  console.error("KQL schema validation FAILED:");
  for (const e of errors) console.error("  -", e);
  process.exit(1);
}
console.log("KQL schema validation OK");
