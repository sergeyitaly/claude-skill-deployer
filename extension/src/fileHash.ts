import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** SHA-256 hex digest of a file's contents. */
export function fileContentHash(filePath: string): string | null {
  try {
    const data = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(data).digest("hex");
  } catch {
    return null;
  }
}

export function stringContentHash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

/** Stable hash over relative paths + file bytes in a directory tree. */
export function dirTreeHash(root: string): string | null {
  if (!fs.existsSync(root)) {
    return null;
  }
  const hash = crypto.createHash("sha256");

  const walk = (dir: string, relPrefix: string): void => {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      const rel = relPrefix ? path.join(relPrefix, entry) : entry;
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, rel);
        continue;
      }
      hash.update(rel.replace(/\\/g, "/"));
      try {
        hash.update(fs.readFileSync(full));
      } catch {
        hash.update("!missing");
      }
    }
  };

  walk(root, "");
  return hash.digest("hex");
}

/** True when dest is missing or content differs from src (file or directory tree). */
export function shouldCopyPath(src: string, dest: string): boolean {
  if (!fs.existsSync(dest)) {
    return true;
  }
  let srcStat: fs.Stats;
  let destStat: fs.Stats;
  try {
    srcStat = fs.statSync(src);
    destStat = fs.statSync(dest);
  } catch {
    return true;
  }
  if (srcStat.isDirectory() !== destStat.isDirectory()) {
    return true;
  }
  if (srcStat.isDirectory()) {
    const srcHash = dirTreeHash(src);
    const destHash = dirTreeHash(dest);
    return srcHash !== destHash;
  }
  return fileContentHash(src) !== fileContentHash(dest);
}
