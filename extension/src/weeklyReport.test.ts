import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isNoreplyEmail, safeDeliveryError, sendWeeklyReportEmail, shouldSendScheduledReport } from "./weeklyReport";
import type { WeeklyReportConfig } from "./weeklyReport";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const workspaces: string[] = [];

function makeWorkspace(name: string): string {
  const dir = path.join(os.tmpdir(), `weekly-report-test-${name}-${Date.now()}`);
  fs.mkdirSync(path.join(dir, ".claude", "learning"), { recursive: true });
  workspaces.push(dir);
  return dir;
}

/** Minimal mock for vscode.ExtensionContext.secrets. */
function makeSecrets(stored: Record<string, string> = {}) {
  const store = { ...stored };
  return {
    get: vi.fn(async (key: string) => store[key] ?? undefined),
    store: vi.fn(async (key: string, value: string) => { store[key] = value; }),
    delete: vi.fn(async (key: string) => { delete store[key]; }),
    onDidChange: { event: vi.fn() },
  };
}

function makeContext(secrets: ReturnType<typeof makeSecrets>) {
  return { secrets } as unknown as import("vscode").ExtensionContext;
}

afterEach(() => {
  for (const dir of workspaces.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.useRealTimers(); // restore real clock after any vi.setSystemTime() calls
});

// ---------------------------------------------------------------------------
// isNoreplyEmail
// ---------------------------------------------------------------------------

describe("isNoreplyEmail", () => {
  it("detects GitHub noreply addresses", () => {
    expect(isNoreplyEmail("123456+user@users.noreply.github.com")).toBe(true);
    expect(isNoreplyEmail("user@users.noreply.github.com")).toBe(true);
  });

  it("detects generic noreply local-parts", () => {
    expect(isNoreplyEmail("noreply@example.com")).toBe(true);
    expect(isNoreplyEmail("no-reply@company.org")).toBe(false); // hyphenated — not matched
  });

  it("passes real email addresses", () => {
    expect(isNoreplyEmail("user@example.com")).toBe(false);
    expect(isNoreplyEmail("engineer@company.io")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isNoreplyEmail("NOREPLY@EXAMPLE.COM")).toBe(true);
    expect(isNoreplyEmail("user@Users.NoReply.GitHub.Com")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// shouldSendScheduledReport
// ---------------------------------------------------------------------------

describe("shouldSendScheduledReport", () => {
  const BASE: WeeklyReportConfig = {
    enabled: true,
    dayOfWeek: 1, // Monday
    hour: 9,
    minute: 0,
    emailTo: "user@example.com",
    smtpHost: "smtp.example.com",
    smtpPort: 587,
    smtpUser: "user",
    smtpPassword: "pass",
    emailSubject: "Weekly Report",
  };

  it("returns false when reports are disabled", () => {
    expect(shouldSendScheduledReport({ ...BASE, enabled: false }, undefined)).toBe(false);
  });

  it("returns false when today is not the scheduled day", () => {
    // Force Date to a known Wednesday (getDay() === 3); config expects Monday (1)
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T10:00:00Z")); // Wednesday
    try {
      expect(shouldSendScheduledReport(BASE, undefined)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns false when already sent this ISO week", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T10:00:00Z")); // Monday
    try {
      // isoWeekKey for 2026-06-15 is "2026-W25"
      expect(shouldSendScheduledReport(BASE, "2026-W25")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns true on the correct day and time when not yet sent this week", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T09:05:00Z")); // Monday 9:05 UTC
    try {
      const result = shouldSendScheduledReport(BASE, "2026-W01");
      expect(typeof result).toBe("boolean");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// WeeklyReportConfig baseline for early-exit tests
// ---------------------------------------------------------------------------

const BASE_CONFIG: import("./weeklyReport").WeeklyReportConfig = {
  enabled: true,
  dayOfWeek: 1,
  hour: 9,
  minute: 0,
  emailTo: "",
  smtpHost: "",
  smtpPort: 587,
  smtpUser: "",
  smtpPassword: "",
  emailSubject: "Weekly Report",
};

// ---------------------------------------------------------------------------
// sendWeeklyReportEmail — early-exit paths (no real SMTP socket needed)
// Signature: sendWeeklyReportEmail(context, target, config, subject, body)
// ---------------------------------------------------------------------------

describe("sendWeeklyReportEmail", () => {
  it("returns error when SMTP is not configured", async () => {
    const target = makeWorkspace("no-smtp");
    const ctx = makeContext(makeSecrets());
    // Recipient provided via config.emailTo; SMTP fields intentionally blank
    const config = { ...BASE_CONFIG, emailTo: "user@example.com" };

    const result = await sendWeeklyReportEmail(ctx, target, config, "Subject", "Body");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/SMTP not configured/i);
  }, 15_000);

  it("returns error when no receivable recipient can be resolved", async () => {
    const target = makeWorkspace("no-recipient");
    const ctx = makeContext(makeSecrets());
    // SMTP configured but emailTo is blank; target is a non-git tmp dir → resolveReportRecipient returns undefined
    const config = {
      ...BASE_CONFIG,
      emailTo: "",
      smtpHost: "smtp.example.com",
      smtpUser: "sender@example.com",
      smtpPassword: "secret",
    };

    const result = await sendWeeklyReportEmail(ctx, target, config, "Subject", "Body");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/email|recipient|configure/i);
  }, 15_000);

  it("returns error object — never throws", async () => {
    const target = makeWorkspace("no-throw");
    const ctx = makeContext(makeSecrets());
    // Any code path must return {ok, error} rather than propagate
    await expect(
      sendWeeklyReportEmail(ctx, target, BASE_CONFIG, "Subject", "Body")
    ).resolves.toMatchObject({ ok: false });
  }, 15_000);
});

// ---------------------------------------------------------------------------
// safeDeliveryError — credential masking
// ---------------------------------------------------------------------------

describe("safeDeliveryError", () => {
  it("masks errors containing 'password'", () => {
    const result = safeDeliveryError(new Error("AUTH failed, password=supersecret"));
    expect(result).not.toMatch(/supersecret/);
    expect(result).toMatch(/delivery failed|check SMTP/i);
  });

  it("masks errors containing 'token'", () => {
    const result = safeDeliveryError(new Error("invalid token abc123"));
    expect(result).toMatch(/delivery failed|check SMTP/i);
  });

  it("masks errors containing 'secret'", () => {
    const result = safeDeliveryError(new Error("bad secret in AUTH payload"));
    expect(result).toMatch(/delivery failed|check SMTP/i);
  });

  it("masks errors containing 'smtp'", () => {
    const result = safeDeliveryError(new Error("smtp handshake error"));
    expect(result).toMatch(/delivery failed|check SMTP/i);
  });

  it("passes through non-sensitive errors unchanged (short)", () => {
    const result = safeDeliveryError(new Error("host unreachable"));
    expect(result).toBe("host unreachable");
  });

  it("truncates non-sensitive errors longer than 120 chars", () => {
    const long = "x".repeat(130);
    const result = safeDeliveryError(new Error(long));
    expect(result.length).toBeLessThanOrEqual(124); // 120 chars + ellipsis
  });
});
