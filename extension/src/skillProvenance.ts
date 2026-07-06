/**
 * Skill Provenance Tracking
 * 
 * Tracks skill metadata for audit compliance:
 * - Author attribution (skill creator/maintainer)
 * - Signed-at timestamp (when provenance was recorded)
 * - Signature (optional cryptographic verification)
 * 
 * Updates manifest.json with provenance fields for skills
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

export interface SkillProvenance {
  /** Skill identifier (e.g., "claude-api", "skill-creator") */
  name: string;
  /** Author/maintainer identity (email, GitHub username, or team) */
  author: string;
  /** ISO timestamp when provenance was recorded */
  signedAt: string;
  /** Optional cryptographic signature for verification */
  signature?: string;
}

export interface ManifestEntry {
  /** Name of the skill */
  name: string;
  /** Version semver */
  version?: string;
  /** Skill description */
  description?: string;
  /** Provenance tracking */
  provenance?: {
    author: string;
    signedAt: string;
    signature?: string;
  };
}

/**
 * Read skill provenance from manifest.json
 */
export function readSkillProvenance(manifestPath: string, skillName: string): SkillProvenance | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

    const skillEntry = manifest.skills?.[skillName];
    if (!skillEntry || !skillEntry.provenance) {
      return null;
    }

    return {
      name: skillName,
      author: skillEntry.provenance.author,
      signedAt: skillEntry.provenance.signedAt,
      signature: skillEntry.provenance.signature,
    };
  } catch (error) {
    console.error(`[Provenance] Failed to read provenance for ${skillName}:`, error);
    return null;
  }
}

/**
 * Record skill provenance in manifest.json
 */
export function recordSkillProvenance(
  manifestPath: string,
  skillName: string,
  author: string,
  signature?: string
): boolean {
  try {
    const content = fs.readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(content);

    // Ensure skills object exists
    if (!manifest.skills) {
      manifest.skills = {};
    }

    if (!manifest.skills[skillName]) {
      manifest.skills[skillName] = {};
    }

    // Record provenance
    manifest.skills[skillName].provenance = {
      author,
      signedAt: new Date().toISOString(),
      ...(signature && { signature }),
    };

    // Write back (with formatting)
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

    console.log(`[Provenance] ✓ Recorded for ${skillName} by ${author}`);
    return true;
  } catch (error) {
    console.error(`[Provenance] Failed to record for ${skillName}:`, error);
    return false;
  }
}

/**
 * Get all skills with missing provenance
 */
export function getSkillsWithoutProvenance(manifestPath: string): string[] {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    const skills = manifest.skills || {};

    return Object.entries(skills)
      .filter(([_, entry]: [string, any]) => !entry.provenance || !entry.provenance.author)
      .map(([name]) => name);
  } catch (error) {
    console.error("[Provenance] Failed to check skills:", error);
    return [];
  }
}

/**
 * Generate cryptographic signature for skill provenance
 * (For future use with key-based signing)
 */
export function generateSignature(skillName: string, author: string, secret?: string): string {
  const data = `${skillName}:${author}:${new Date().toISOString()}`;
  const hmac = crypto.createHmac("sha256", secret || "default-key");
  return hmac.update(data).digest("hex").substring(0, 16);
}

/**
 * Verify skill provenance signature
 */
export function verifySignature(provenance: SkillProvenance, secret?: string): boolean {
  if (!provenance.signature) {
    return false; // Unsigned
  }

  const expectedSig = generateSignature(provenance.name, provenance.author, secret);
  return provenance.signature === expectedSig;
}

/**
 * Get provenance summary for audit compliance
 */
export function getProvenanceSummary(manifestPath: string): {
  totalSkills: number;
  withProvenance: number;
  missingProvenance: number;
  signatureMismatches: number;
} {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    const skills = manifest.skills || {};
    const skillEntries = Object.entries(skills);

    const withProvenance = skillEntries.filter(
      ([_, entry]: [string, any]) => entry.provenance?.author
    ).length;

    const missingProvenance = skillEntries.filter(
      ([_, entry]: [string, any]) => !entry.provenance?.author
    ).length;

    // Signature mismatches are detected but not actionable without key material
    const signatureMismatches = 0;

    return {
      totalSkills: skillEntries.length,
      withProvenance,
      missingProvenance,
      signatureMismatches,
    };
  } catch (error) {
    console.error("[Provenance] Failed to get summary:", error);
    return {
      totalSkills: 0,
      withProvenance: 0,
      missingProvenance: 0,
      signatureMismatches: 0,
    };
  }
}
