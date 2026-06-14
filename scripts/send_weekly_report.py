#!/usr/bin/env python3
"""Print or email a weekly Claude Skills cost report (email optional via env)."""

from __future__ import annotations

import argparse
import os
import smtplib
import sys
from email.mime.text import MIMEText
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from cost_intelligence import generate_suggestions, load_cost_attribution, weekly_summary_from_runs  # noqa: E402


def build_email_body(summary: dict, target: Path) -> str:
    lines = [
        "Weekly Claude Skills Benefits Report",
        "",
        f"Workspace: {target}",
        "",
        "Extension benefits (from runs.jsonl / project-profile when available):",
        "  - See VS Code report for tier savings, skill success rates, and cross-agent value.",
        "",
        f"AI spend this week: ${summary['total']:.2f} ({summary['total_tokens']:,} tokens)",
        f"Change vs prior week: {summary['vs_last_week_percent']:+.1f}%",
        "",
        "Top skills by cost:",
    ]
    for row in summary.get("top_skills", [])[:5]:
        lines.append(f"  - {row['name']}: ${row['cost']:.2f}")

    opts = summary.get("optimizations") or []
    if opts:
        lines.extend(["", "Savings opportunities:"])
        for o in opts[:5]:
            lines.append(f"  - {o.get('description', o)}")

    lines.append("")
    lines.append("Open VS Code: Claude Skills -> Show Cost Intelligence Dashboard")
    return "\n".join(lines)


def maybe_send_email(body: str, subject: str) -> bool:
    host = os.environ.get("CLAUDE_SKILLS_SMTP_HOST")
    user = os.environ.get("CLAUDE_SKILLS_SMTP_USER")
    password = os.environ.get("CLAUDE_SKILLS_SMTP_PASSWORD")
    to_addr = os.environ.get("CLAUDE_SKILLS_REPORT_TO")
    from_addr = os.environ.get("CLAUDE_SKILLS_REPORT_FROM", user or "claude-skills@local")

    if not all([host, user, password, to_addr]):
        return False

    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = from_addr
    msg["To"] = to_addr

    with smtplib.SMTP(host, int(os.environ.get("CLAUDE_SKILLS_SMTP_PORT", "587"))) as server:
        server.starttls()
        server.login(user, password)
        server.sendmail(from_addr, [to_addr], msg.as_string())
    return True


def build_optimization_issue_body(summary: dict, suggestions: list[dict]) -> str:
    weekly_total = summary["total"]
    change_percent = summary["vs_last_week_percent"]
    lines = [
        "# Weekly Cost Optimization",
        "",
        f"**Total spent this week:** ${weekly_total:.2f}",
        f"**Change from last week:** {change_percent:+.1f}%",
        "",
        "## Suggested Changes",
        "",
    ]
    for s in suggestions[:5]:
        savings = s.get("savings", 0)
        desc = s.get("description", s.get("action", str(s)))
        lines.append(f"- [ ] {desc} (save ~${savings:.2f}/week)")
    lines.extend(
        [
            "",
            "## Auto-optimization",
            "",
            "Run `py generate_skills.py cost-report` and use VS Code **Apply Cost Optimizations**.",
        ]
    )
    return "\n".join(lines)


def create_github_issue(title: str, body: str, cwd: Path) -> bool:
    import subprocess

    try:
        subprocess.run(
            ["gh", "issue", "create", "--title", title, "--body", body],
            cwd=cwd,
            check=True,
            capture_output=True,
            text=True,
        )
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", type=Path, default=Path.cwd())
    parser.add_argument("--email", action="store_true", help="Send via SMTP if CLAUDE_SKILLS_SMTP_* env vars set")
    parser.add_argument("--create-issue", action="store_true", help="Open GitHub issue via gh CLI")
    args = parser.parse_args()

    target = args.target.resolve()
    summary = weekly_summary_from_runs(target)
    attr = load_cost_attribution()
    suggestions = generate_suggestions(attr, target)
    body = build_email_body(summary, target)
    print(body)

    if args.email:
        if maybe_send_email(body, "Weekly Claude Skills Cost Report"):
            print("\nEmail sent.")
        else:
            print("\nEmail skipped (set CLAUDE_SKILLS_SMTP_HOST, _USER, _PASSWORD, REPORT_TO).")

    if args.create_issue:
        issue_body = build_optimization_issue_body(summary, suggestions)
        if create_github_issue("Weekly Cost Optimization", issue_body, target):
            print("\nGitHub issue created.")
        else:
            print("\nCould not create GitHub issue (gh CLI required).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
