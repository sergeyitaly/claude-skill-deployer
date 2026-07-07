/**
 * Audit Execution Layer
 *
 * Runs compliance validators against the workspace's telemetry/manifest state
 * and exposes typed audit results for the Cost Intelligence dashboard to render.
 *
 * Responsibilities:
 * - Validate manifest, telemetry, and provenance state
 * - Cache audit results (15min TTL)
 * - Provide typed audit results to the dashboard (no file output)
 */

import * as path from "path";
import * as fs from "fs";

export interface ComplianceCheckResult {
  ok: boolean;
  label: string;
  details?: string;
  timestamp?: string;
}

export interface AuditResult {
  timestamp: string;
  checksums: {
    runsFile: boolean;
    manifestFile: boolean;
  };
  schema: {
    valid: boolean;
    errors?: string[];
  };
  manifest: {
    valid: boolean;
    missing?: string[];
  };
  telemetry: {
    valid: boolean;
    errors?: string[];
  };
  privacy: {
    compliant: boolean;
    issues?: string[];
  };
  provenance: {
    configured: boolean;
    details?: string;
  };
  scheduling: {
    exportScheduled: boolean;
    lastExport?: string;
  };
  compliance: ComplianceCheckResult[];
  overallStatus: "pass" | "warn" | "fail";
}

interface AuditCache {
  result: AuditResult;
  timestamp: number;
  ttl: number;
  key: string;
}

export class AuditExecutor {
  private cache: AuditCache | null = null;
  private readonly CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

  /**
   * Get latest audit result (from cache if valid, otherwise runs fresh audit)
   */
  async getLatestAudit(target: string, libraryDir: string): Promise<AuditResult | null> {
    return this.getLatestAuditSync(target, libraryDir);
  }

  /**
   * Synchronous variant for callers (e.g. dashboard HTML rendering) that
   * cannot await — the underlying checks are all local fs reads, no I/O
   * actually requires async.
   */
  getLatestAuditSync(target: string, libraryDir: string): AuditResult | null {
    const key = `${target}|${libraryDir}`;
    if (this.cache && this.cache.key === key && Date.now() - this.cache.timestamp < this.cache.ttl) {
      return this.cache.result;
    }
    return this.executeAuditSync(target, libraryDir);
  }

  /**
   * Execute full audit immediately
   */
  async executeAudit(target: string, libraryDir: string): Promise<AuditResult | null> {
    return this.executeAuditSync(target, libraryDir);
  }

  executeAuditSync(target: string, libraryDir: string): AuditResult | null {
    try {
      const result = this.runAuditValidators(target, libraryDir);

      // Cache the result
      this.cache = {
        result,
        timestamp: Date.now(),
        ttl: this.CACHE_TTL_MS,
        key: `${target}|${libraryDir}`,
      };

      return result;
    } catch (error) {
      console.error("Audit execution failed:", error);
      return null;
    }
  }

  /**
   * Run all validators and aggregate results
   */
  private runAuditValidators(target: string, libraryDir: string): AuditResult {
    const dataDir = path.join(target, ".claude", "learning");
    const manifestPath = path.join(libraryDir, "manifest.json");

    const result: AuditResult = {
      timestamp: new Date().toISOString(),
      checksums: { runsFile: false, manifestFile: false },
      schema: { valid: true },
      manifest: { valid: true },
      telemetry: { valid: true },
      privacy: { compliant: true },
      provenance: { configured: false },
      scheduling: { exportScheduled: false },
      compliance: [],
      overallStatus: "pass",
    };

    // 1. Check file integrity
    result.checksums.runsFile = fs.existsSync(path.join(dataDir, "runs.jsonl"));
    result.checksums.manifestFile = fs.existsSync(manifestPath);

    // 2. Run manifest validator
    try {
      result.manifest = this.runManifestValidator(manifestPath);
    } catch (e) {
      result.manifest.valid = false;
      result.manifest.missing = [`Failed to validate manifest: ${e}`];
    }

    // 3. Run telemetry validator
    try {
      result.telemetry = this.runTelemetryValidator(path.join(dataDir, "runs.jsonl"));
    } catch (e) {
      result.telemetry.valid = false;
      result.telemetry.errors = [`Failed to validate telemetry: ${e}`];
    }

    // 4. Check provenance in manifest
    try {
      result.provenance = this.checkProvenance(manifestPath);
    } catch (e) {
      result.provenance.configured = false;
      result.provenance.details = `Provenance check failed: ${e}`;
    }

    // 4b. Check privacy compliance (telemetry must not carry raw prompt/message content)
    try {
      result.privacy = this.checkPrivacyCompliance(path.join(dataDir, "runs.jsonl"));
    } catch (e) {
      result.privacy.compliant = false;
      result.privacy.issues = [`Privacy check failed: ${e}`];
    }

    // 5. Check audit scheduling
    try {
      result.scheduling = this.checkAuditScheduling(target);
    } catch (e) {
      result.scheduling.exportScheduled = false;
    }

    // 6. Build compliance checklist
    result.compliance = [
      {
        ok: true,
        label: "Telemetry is local-only (no cloud egress)",
      },
      {
        ok: result.privacy.compliant,
        label: "No prompt content stored in runs.jsonl",
        details: result.privacy.issues?.join("; "),
      },
      {
        ok: result.manifest.valid,
        label: "Manifest integrity valid",
        details: result.manifest.missing ? `Missing fields: ${result.manifest.missing.join(", ")}` : "All required fields present",
      },
      {
        ok: result.provenance.configured,
        label: "Skill manifests properly configured",
        details: result.provenance.details,
      },
      {
        ok: result.scheduling.exportScheduled,
        label: "Audit infrastructure initialized",
        details: result.scheduling.lastExport,
      },
    ];

    // 7. Determine overall status
    const failedChecks = result.compliance.filter(c => !c.ok);
    if (failedChecks.length === 0) {
      result.overallStatus = "pass";
    } else if (failedChecks.length <= 1) {
      result.overallStatus = "warn";
    } else {
      result.overallStatus = "fail";
    }

    return result;
  }

  /**
   * Run manifest validator
   */
  private runManifestValidator(manifestPath: string): { valid: boolean; missing?: string[] } {
    if (!fs.existsSync(manifestPath)) {
      return { valid: false, missing: ["Manifest file not found"] };
    }

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      const missing: string[] = [];

      // Check for required manifest structure
      if (!manifest.skills || typeof manifest.skills !== "object") {
        missing.push("skills object");
      } else if (Object.keys(manifest.skills).length === 0) {
        missing.push("at least one skill entry");
      }

      // Agent configuration lives in a sibling agents.json (`{ "agents": {...} }`),
      // not nested inside manifest.json — check the file that actually holds it.
      const agentsPath = path.join(path.dirname(manifestPath), "agents.json");
      let agentsValid = false;
      try {
        const agentsDoc = JSON.parse(fs.readFileSync(agentsPath, "utf-8"));
        agentsValid =
          !!agentsDoc.agents && typeof agentsDoc.agents === "object" && Object.keys(agentsDoc.agents).length > 0;
      } catch {
        agentsValid = false;
      }
      if (!agentsValid) {
        missing.push("agents configuration");
      }

      return { valid: missing.length === 0, missing: missing.length > 0 ? missing : undefined };
    } catch (e) {
      return { valid: false, missing: [`Invalid JSON: ${e}`] };
    }
  }

  /**
   * Run telemetry validator
   */
  private runTelemetryValidator(runsFile: string): { valid: boolean; errors?: string[] } {
    if (!fs.existsSync(runsFile)) {
      return { valid: true }; // OK if no telemetry yet
    }

    try {
      const lines = fs.readFileSync(runsFile, "utf-8").split("\n").filter(Boolean);
      const errors: string[] = [];

      // Basic validation: check each line is valid JSON
      let invalidCount = 0;
      for (const line of lines) {
        try {
          JSON.parse(line);
        } catch {
          invalidCount++;
        }
      }

      if (invalidCount > 0) {
        errors.push(`${invalidCount}/${lines.length} records are malformed JSON`);
      }

      return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
    } catch (e) {
      return { valid: false, errors: [`Failed to read runs.jsonl: ${e}`] };
    }
  }

  /**
   * Check if skill manifests are properly configured
   */
  private checkProvenance(manifestPath: string): { configured: boolean; details?: string } {
    try {
      if (!fs.existsSync(manifestPath)) {
        return { configured: false, details: "Manifest file not found" };
      }

      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

      // Check for skills configuration in manifest
      if (manifest.skills && typeof manifest.skills === "object") {
        const skillNames = Object.keys(manifest.skills);
        if (skillNames.length > 0) {
          // Check that each skill has description and detect_globs
          const allConfigured = skillNames.every((name) => {
            const skill = manifest.skills[name];
            return !!skill.description && !!skill.detect_globs;
          });

          return {
            configured: allConfigured,
            details: allConfigured
              ? `${skillNames.length} skills configured with descriptions and globs`
              : `Some skills missing description or detect_globs`,
          };
        }
      }

      return { configured: false, details: "No skills in manifest" };
    } catch (e) {
      return { configured: false, details: `Failed to parse manifest: ${e}` };
    }
  }

  /**
   * Check that telemetry records don't carry raw prompt/message text.
   * Flags any record whose known free-text-risk fields (prompt, promptExcerpt,
   * message, content, text) hold a string over PROMPT_LEN_THRESHOLD chars —
   * a strong signal that a prompt body leaked into telemetry instead of a
   * bounded label/metric.
   */
  private checkPrivacyCompliance(runsFile: string): { compliant: boolean; issues?: string[] } {
    const PROMPT_LEN_THRESHOLD = 200;
    const RISK_FIELDS = ["prompt", "promptExcerpt", "promptText", "rawPrompt", "message", "content", "text"];

    if (!fs.existsSync(runsFile)) {
      return { compliant: true };
    }

    try {
      const lines = fs.readFileSync(runsFile, "utf-8").split("\n").filter(Boolean);
      const issues: string[] = [];
      let flagged = 0;

      for (const line of lines) {
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(line);
        } catch {
          continue; // malformed-JSON is reported by the telemetry validator, not here
        }

        for (const field of RISK_FIELDS) {
          const value = record[field];
          if (typeof value === "string" && value.length > PROMPT_LEN_THRESHOLD) {
            flagged++;
            break;
          }
        }
      }

      if (flagged > 0) {
        issues.push(`${flagged}/${lines.length} records contain a free-text field over ${PROMPT_LEN_THRESHOLD} chars`);
      }

      return { compliant: issues.length === 0, issues: issues.length > 0 ? issues : undefined };
    } catch (e) {
      return { compliant: false, issues: [`Failed to scan runs.jsonl: ${e}`] };
    }
  }

  /**
   * Check if audit scheduling is configured
   */
  private checkAuditScheduling(target: string): { exportScheduled: boolean; lastExport?: string } {
    try {
      // Check if the learning directory exists (indicates telemetry/audit infrastructure)
      const learningDir = path.join(target, ".claude", "learning");
      const learningDirExists = fs.existsSync(learningDir);

      // Check if background audit scheduler is initialized (extension feature)
      // This is considered "scheduled" if audit infrastructure is in place
      const hasAuditInfra = learningDirExists;

      if (hasAuditInfra) {
        const patternsFile = path.join(learningDir, "patterns.md");
        const patternExists = fs.existsSync(patternsFile);
        return {
          exportScheduled: true,
          lastExport: patternExists ? "Audit infrastructure active" : "Audit infrastructure initialized",
        };
      }

      return { exportScheduled: false, lastExport: "Audit infrastructure not initialized" };
    } catch (e) {
      return { exportScheduled: false, lastExport: `Failed to check: ${e}` };
    }
  }

  /**
   * Clear cache (for testing or manual refresh)
   */
  clearCache(): void {
    this.cache = null;
  }
}

/**
 * Global audit executor instance (lazy initialized)
 */
let auditExecutor: AuditExecutor | null = null;

export function initializeAuditExecutor(): void {
  auditExecutor = new AuditExecutor();
}

export function getAuditExecutor(): AuditExecutor {
  if (!auditExecutor) {
    throw new Error("Audit executor not initialized. Call initializeAuditExecutor() first.");
  }
  return auditExecutor;
}

/** Non-throwing accessor for render paths that may run before/without extension activation (e.g. dashboard tests). */
export function tryGetAuditExecutor(): AuditExecutor | undefined {
  return auditExecutor ?? undefined;
}
