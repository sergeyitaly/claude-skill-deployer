#!/usr/bin/env python3
"""
Telemetry Integrity and Effectiveness Audit Framework for Claude Skills Manager.

This module provides comprehensive audit verification against six key metric categories:
1. Prompt Intelligence - Score calculation accuracy
2. Recommendation Engine - Skill proposal confidence and relevance
3. False Positive Suppression - Ignore counter and penalty mechanism
4. Coaching Decay Loop - Advice visibility and cooldown state
5. Cost Attribution - Token/cost/success tracking accuracy
6. HACE Formula - Weight validation and metric calculation

Usage:
    python telemetry_audit_framework.py [--check CHECK_NUM] [--data-dir PATH]

Output:
    - HTML report with PASS/FAIL status per check
    - Detailed metrics table
    - Evidence summary
"""

from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
import sys


# ============================================================================
# DATA STRUCTURES - Match expected telemetry file formats
# ============================================================================


@dataclass
class PromptIntelligenceRecord:
    """Represents one prompt analysis from prompt-intelligence.jsonl"""
    ts: str
    prompt_text: str
    score: float
    goal_clarity: int  # 0-100
    evidence_quality: int  # 0-100
    environment_context: int  # 0-100
    success_criteria: int  # 0-100
    classification: str  # "vague", "multi-goal", "structured"
    
    @property
    def average_dimensions(self) -> float:
        return (
            self.goal_clarity +
            self.evidence_quality +
            self.environment_context +
            self.success_criteria
        ) / 4


@dataclass
class ProposalOutcomeRecord:
    """Represents one skill proposal from proposalOutcome.jsonl"""
    ts: str
    session_id: str
    prompt: str
    proposed_skill: str
    confidence: float  # 0-100
    affinity: float  # 0-100
    reasons: list[str]
    penalties: dict[str, float]  # reason -> penalty amount
    accepted: bool
    skill_invoked: bool


@dataclass
class RecommendationFeedbackRecord:
    """Represents feedback on a recommendation from recommendation-feedback.jsonl"""
    ts: str
    session_id: str
    proposal_id: str
    skill: str
    feedback_type: str  # "ignore", "accept", "accept_later"
    ignored_count: int
    still_eligible: bool


@dataclass
class CoachingEventRecord:
    """Single coaching interaction from coaching-events.jsonl"""
    ts: str
    skill: str
    advice_shown: bool
    outcome: str  # "improved", "no_change", "dismissed"
    ignored_count: int


@dataclass
class CoachingState:
    """Current coaching state from coaching-state.json"""
    skill: str
    advice_shown_count: int
    no_improvement_count: int
    ignored_count: int
    last_advice_ts: str | None
    cooldown_until: str | None
    should_show_advice: bool


@dataclass
class RunRecord:
    """Represents one skill run from runs.jsonl"""
    ts: str
    skill: str
    action: str
    rc: int  # return code
    duration: float
    error: str
    tokens: int
    cost: float
    cost_source: str
    success: bool
    metadata: dict[str, Any]


@dataclass
class HACESessionRecord:
    """Represents one session metric from hace-sessions.jsonl"""
    session_id: str
    ts: str
    prompt_clarity_score: float
    task_velocity_score: float
    context_quality_score: float
    execution_efficiency_score: float
    weights: dict[str, float]
    hace_score: float


# ============================================================================
# CHECK 1 - PROMPT INTELLIGENCE
# ============================================================================


class PromptIntelligenceAudit:
    """Verify prompt intelligence scoring matches expected ranges."""
    
    EXPECTED_RANGES = {
        "vague": (20, 40),
        "multi-goal": (0, 20),
        "structured": (70, 100),
    }
    
    def __init__(self, records: list[PromptIntelligenceRecord]):
        self.records = records
        self.results = {}
    
    def run(self) -> dict[str, Any]:
        """Execute prompt intelligence audit."""
        if not self.records:
            return {"status": "SKIP", "reason": "No prompt-intelligence.jsonl data"}
        
        # Group by classification
        grouped = {}
        for rec in self.records:
            if rec.classification not in grouped:
                grouped[rec.classification] = []
            grouped[rec.classification].append(rec)
        
        scores_by_type = {}
        for typ, recs in grouped.items():
            scores = [r.score for r in recs]
            scores_by_type[typ] = {
                "count": len(recs),
                "min": min(scores),
                "max": max(scores),
                "avg": sum(scores) / len(scores),
                "expected_range": self.EXPECTED_RANGES.get(typ),
            }
        
        # Verify scoring matches expectations
        violations = []
        for typ, expected_min, expected_max in [
            ("vague", 20, 40),
            ("multi-goal", 0, 20),
            ("structured", 70, 100),
        ]:
            if typ not in scores_by_type:
                continue
            avg = scores_by_type[typ]["avg"]
            if not (expected_min <= avg <= expected_max):
                violations.append(
                    f"{typ}: avg={avg:.1f}, expected {expected_min}-{expected_max}"
                )
        
        # Verify structured > vague
        if "structured" in scores_by_type and "vague" in scores_by_type:
            if scores_by_type["structured"]["avg"] <= scores_by_type["vague"]["avg"]:
                violations.append(
                    "Structured score should be > Vague score"
                )
        
        status = "PASS" if not violations else "FAIL"
        return {
            "status": status,
            "scores_by_type": scores_by_type,
            "violations": violations,
        }


# ============================================================================
# CHECK 2 - RECOMMENDATION ENGINE
# ============================================================================


class RecommendationEngineAudit:
    """Verify skill proposals have correct confidence and handle vague prompts."""
    
    def __init__(self, records: list[ProposalOutcomeRecord]):
        self.records = records
    
    def run(self) -> dict[str, Any]:
        """Execute recommendation engine audit."""
        if not self.records:
            return {"status": "SKIP", "reason": "No proposalOutcome.jsonl data"}
        
        violations = []
        
        # Check 1: "Create Vitest tests" should recommend vitest-extension-testing
        #           with confidence >= 80
        vitest_proposals = [
            r for r in self.records
            if "vitest" in r.prompt.lower() and "test" in r.prompt.lower()
        ]
        vitest_high_conf = [
            r for r in vitest_proposals
            if r.proposed_skill == "vitest-extension-testing" and r.confidence >= 80
        ]
        if vitest_proposals and not vitest_high_conf:
            violations.append(
                "No high-confidence vitest-extension-testing proposal for Vitest test prompt"
            )
        
        # Check 2: "fix dashboard" should NOT have dormant skills
        dashboard_proposals = [
            r for r in self.records
            if "dashboard" in r.prompt.lower() and "fix" in r.prompt.lower()
        ]
        dormant_dashboard = [
            r for r in dashboard_proposals
            if r.confidence < 30  # Consider <30 as "dormant"
        ]
        if len(dormant_dashboard) / len(dashboard_proposals) > 0.5:
            violations.append(
                f"Too many low-confidence (dormant) proposals for dashboard prompt: "
                f"{len(dormant_dashboard)}/{len(dashboard_proposals)}"
            )
        
        # General statistics
        avg_confidence = sum(r.confidence for r in self.records) / len(self.records)
        high_conf_count = len([r for r in self.records if r.confidence >= 80])
        
        status = "PASS" if not violations else "FAIL"
        return {
            "status": status,
            "statistics": {
                "total_proposals": len(self.records),
                "avg_confidence": avg_confidence,
                "high_confidence_count": high_conf_count,
                "high_confidence_ratio": high_conf_count / len(self.records),
            },
            "violations": violations,
        }


# ============================================================================
# CHECK 3 - FALSE POSITIVE SUPPRESSION
# ============================================================================


class FalsePositiveSuppressionAudit:
    """Verify ignore counter triggers suppression at 3 ignores."""
    
    SUPPRESSION_THRESHOLD = 3
    
    def __init__(self, records: list[RecommendationFeedbackRecord]):
        self.records = records
    
    def run(self) -> dict[str, Any]:
        """Execute false positive suppression audit."""
        if not self.records:
            return {"status": "SKIP", "reason": "No recommendation-feedback.jsonl data"}
        
        violations = []
        
        # Group by skill to track ignore progression
        skills_ignored = {}
        for rec in sorted(self.records, key=lambda r: r.ts):
            skill = rec.skill
            if skill not in skills_ignored:
                skills_ignored[skill] = {"ignored": [], "suppressed": []}
            
            if rec.feedback_type == "ignore":
                skills_ignored[skill]["ignored"].append(rec)
            if not rec.still_eligible:
                skills_ignored[skill]["suppressed"].append(rec)
        
        # Verify suppression rules
        for skill, data in skills_ignored.items():
            ignore_count = len(data["ignored"])
            is_suppressed = len(data["suppressed"]) > 0
            
            # After 2 ignores: should still be eligible
            if ignore_count == 2 and is_suppressed:
                violations.append(
                    f"{skill}: Suppressed after only 2 ignores (should need 3)"
                )
            
            # After 3+ ignores: should be suppressed
            if ignore_count >= 3 and not is_suppressed:
                violations.append(
                    f"{skill}: NOT suppressed after {ignore_count} ignores"
                )
        
        status = "PASS" if not violations else "FAIL"
        return {
            "status": status,
            "skills_analyzed": len(skills_ignored),
            "skill_details": {
                skill: {
                    "ignored_count": len(data["ignored"]),
                    "suppressed_count": len(data["suppressed"]),
                }
                for skill, data in skills_ignored.items()
            },
            "violations": violations,
        }


# ============================================================================
# CHECK 4 - COACHING DECAY LOOP
# ============================================================================


class CoachingDecayAudit:
    """Verify coaching advice shows -> no improvement -> count increases -> cooldown."""
    
    def __init__(self, events: list[CoachingEventRecord], state_file: Path):
        self.events = events
        self.state_file = state_file
        self.current_state = None
        if state_file.exists():
            self.current_state = json.loads(state_file.read_text())
    
    def run(self) -> dict[str, Any]:
        """Execute coaching decay loop audit."""
        if not self.events and not self.current_state:
            return {"status": "SKIP", "reason": "No coaching data"}
        
        violations = []
        
        # Trace the decay loop for each skill
        skill_progression = {}
        for event in sorted(self.events, key=lambda e: e.ts):
            skill = event.skill
            if skill not in skill_progression:
                skill_progression[skill] = []
            skill_progression[skill].append(event)
        
        for skill, events_list in skill_progression.items():
            advice_shown = sum(1 for e in events_list if e.advice_shown)
            no_change = sum(1 for e in events_list if e.outcome == "no_change")
            ignored = sum(1 for e in events_list if e.outcome == "dismissed")
            
            # Check progression: shown -> no_change -> ignored_count increases
            if advice_shown > 0 and no_change > 0:
                # Verify ignored_count increases
                ignored_counts = [
                    e.ignored_count for e in events_list
                    if e.outcome in ("no_change", "dismissed")
                ]
                if ignored_counts and ignored_counts[-1] < 3:
                    violations.append(
                        f"{skill}: After no_change outcomes, ignored_count should reach 3+ "
                        f"but is {ignored_counts[-1]}"
                    )
        
        # Verify current state reflects cooldown activation at 3 ignores
        if self.current_state:
            for skill_state in self.current_state:
                if isinstance(skill_state, dict):
                    ignored = skill_state.get("ignored_count", 0)
                    cooldown = skill_state.get("cooldown_until")
                    
                    if ignored >= 3 and not cooldown:
                        violations.append(
                            f"{skill_state.get('skill')}: Has {ignored} ignores but no cooldown active"
                        )
                    if ignored < 3 and cooldown:
                        violations.append(
                            f"{skill_state.get('skill')}: Cooldown active but only {ignored} ignores"
                        )
        
        status = "PASS" if not violations else "FAIL"
        return {
            "status": status,
            "skills_tracked": len(skill_progression),
            "state_available": self.current_state is not None,
            "violations": violations,
        }


# ============================================================================
# CHECK 5 - COST ATTRIBUTION
# ============================================================================


class CostAttributionAudit:
    """Verify runs.jsonl contains accurate token/cost/success data."""
    
    def __init__(self, records: list[RunRecord]):
        self.records = records
    
    def run(self) -> dict[str, Any]:
        """Execute cost attribution audit."""
        if not self.records:
            return {"status": "SKIP", "reason": "No runs.jsonl data"}
        
        violations = []
        
        # Verify required fields exist
        missing_fields = {
            "tokens": 0,
            "cost": 0,
            "success": 0,
            "cost_source": 0,
        }
        
        for rec in self.records:
            if rec.tokens is None or rec.tokens == 0:
                missing_fields["tokens"] += 1
            if rec.cost is None:
                missing_fields["cost"] += 1
            if rec.success is None:
                missing_fields["success"] += 1
            if not rec.cost_source:
                missing_fields["cost_source"] += 1
        
        for field, count in missing_fields.items():
            if count > len(self.records) * 0.1:  # Allow 10% missing
                violations.append(
                    f"{field}: Missing in {count}/{len(self.records)} records"
                )
        
        # Calculate metrics
        total_invocations = len(self.records)
        successful_runs = sum(1 for r in self.records if r.success)
        success_rate = successful_runs / total_invocations if total_invocations > 0 else 0
        
        total_cost = sum(r.cost for r in self.records if r.cost)
        total_tokens = sum(r.tokens for r in self.records if r.tokens)
        avg_cost_per_run = total_cost / total_invocations if total_invocations > 0 else 0
        
        # Cost source consistency
        cost_sources = {}
        for rec in self.records:
            cost_sources[rec.cost_source] = cost_sources.get(rec.cost_source, 0) + 1
        
        status = "PASS" if not violations else "FAIL"
        return {
            "status": status,
            "total_invocations": total_invocations,
            "success_rate": success_rate,
            "total_cost": total_cost,
            "total_tokens": total_tokens,
            "avg_cost_per_run": avg_cost_per_run,
            "cost_sources": cost_sources,
            "missing_fields": missing_fields,
            "violations": violations,
        }


# ============================================================================
# CHECK 6 - HACE FORMULA
# ============================================================================


class HACEFormulaAudit:
    """Verify HACE scoring formula weights and calculations."""
    
    def __init__(self, records: list[HACESessionRecord]):
        self.records = records
    
    def run(self) -> dict[str, Any]:
        """Execute HACE formula audit."""
        if not self.records:
            return {"status": "SKIP", "reason": "No hace-sessions.jsonl data"}
        
        violations = []
        
        # Verify weights sum to 1.0
        weight_violations = []
        for rec in self.records:
            weights_sum = sum(rec.weights.values()) if rec.weights else 0
            if abs(weights_sum - 1.0) > 0.01:  # Allow small floating point error
                weight_violations.append({
                    "session": rec.session_id,
                    "weights_sum": weights_sum,
                    "weights": rec.weights,
                })
        
        if weight_violations:
            violations.append(
                f"Found {len(weight_violations)} sessions with weights not summing to 1.0"
            )
        
        # Verify HACE score calculation
        score_violations = []
        for rec in self.records:
            if not rec.weights:
                continue
            
            # Calculate expected HACE from components
            expected_hace = (
                rec.prompt_clarity_score * rec.weights.get("prompt_clarity", 0) +
                rec.task_velocity_score * rec.weights.get("task_velocity", 0) +
                rec.context_quality_score * rec.weights.get("context_quality", 0) +
                rec.execution_efficiency_score * rec.weights.get("execution_efficiency", 0)
            )
            
            if abs(expected_hace - rec.hace_score) > 0.01:
                score_violations.append({
                    "session": rec.session_id,
                    "expected": expected_hace,
                    "actual": rec.hace_score,
                    "delta": abs(expected_hace - rec.hace_score),
                })
        
        if score_violations:
            violations.append(
                f"Found {len(score_violations)} sessions with mismatched HACE calculations"
            )
        
        # Calculate statistics
        avg_scores = {
            "prompt_clarity": sum(r.prompt_clarity_score for r in self.records) / len(self.records),
            "task_velocity": sum(r.task_velocity_score for r in self.records) / len(self.records),
            "context_quality": sum(r.context_quality_score for r in self.records) / len(self.records),
            "execution_efficiency": sum(r.execution_efficiency_score for r in self.records) / len(self.records),
            "hace": sum(r.hace_score for r in self.records) / len(self.records),
        }
        
        status = "PASS" if not violations else "FAIL"
        return {
            "status": status,
            "records_analyzed": len(self.records),
            "average_scores": avg_scores,
            "weight_violations": len(weight_violations),
            "score_calculation_violations": len(score_violations),
            "violations": violations,
        }


# ============================================================================
# MAIN AUDIT RUNNER
# ============================================================================


class TelemetryAuditRunner:
    """Orchestrates all audit checks."""
    
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.results = {}
    
    def load_jsonl(self, filename: str, record_class) -> list:
        """Load JSONL file and convert to record objects."""
        path = self.data_dir / filename
        if not path.exists():
            return []
        
        records = []
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    try:
                        data = json.loads(line)
                        records.append(record_class(**data))
                    except (json.JSONDecodeError, TypeError) as e:
                        print(f"Warning: Failed to parse line in {filename}: {e}")
        return records
    
    def run_all_checks(self) -> dict[str, Any]:
        """Execute all six audit checks."""
        print("Loading telemetry data...")
        
        # Load all data
        prompt_intel = self.load_jsonl("prompt-intelligence.jsonl", PromptIntelligenceRecord)
        proposals = self.load_jsonl("proposalOutcome.jsonl", ProposalOutcomeRecord)
        feedback = self.load_jsonl("recommendation-feedback.jsonl", RecommendationFeedbackRecord)
        coaching_events = self.load_jsonl("coaching-events.jsonl", CoachingEventRecord)
        runs = self.load_jsonl("runs.jsonl", RunRecord)
        hace = self.load_jsonl("hace-sessions.jsonl", HACESessionRecord)
        
        print(f"Loaded: {len(prompt_intel)} prompt records, {len(proposals)} proposals, "
              f"{len(feedback)} feedback, {len(coaching_events)} events, "
              f"{len(runs)} runs, {len(hace)} HACE records")
        
        # Run checks
        print("\nRunning audit checks...")
        
        self.results = {
            "check_1_prompt_intelligence": PromptIntelligenceAudit(prompt_intel).run(),
            "check_2_recommendation_engine": RecommendationEngineAudit(proposals).run(),
            "check_3_false_positive_suppression": FalsePositiveSuppressionAudit(feedback).run(),
            "check_4_coaching_decay": CoachingDecayAudit(
                coaching_events, self.data_dir / "coaching-state.json"
            ).run(),
            "check_5_cost_attribution": CostAttributionAudit(runs).run(),
            "check_6_hace_formula": HACEFormulaAudit(hace).run(),
        }
        
        return self.results
    
    def generate_report(self) -> str:
        """Generate HTML audit report."""
        html = """<!DOCTYPE html>
<html>
<head>
    <title>Telemetry Audit Report</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 20px; }
        h1 { color: #333; }
        .check { margin: 20px 0; padding: 15px; border: 1px solid #ddd; border-radius: 8px; }
        .pass { background: #e6ffe6; border-left: 4px solid #4caf50; }
        .fail { background: #ffe6e6; border-left: 4px solid #f44336; }
        .skip { background: #f0f0f0; border-left: 4px solid #999; }
        .status { font-weight: bold; font-size: 18px; margin: 10px 0; }
        table { border-collapse: collapse; width: 100%; margin: 10px 0; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
        th { background: #f5f5f5; }
        .violation { color: #d32f2f; margin: 5px 0; }
        .timestamp { color: #666; font-size: 0.9em; }
    </style>
</head>
<body>
    <h1>Claude Skills Manager - Telemetry Integrity Audit</h1>
    <p class="timestamp">Generated: {timestamp}</p>
"""
        
        for check_name, result in self.results.items():
            check_num = check_name.split("_")[1]
            status_class = result["status"].lower()
            
            html += f"""
    <div class="check {status_class}">
        <h2>CHECK {check_num}: {check_name.replace("_", " ").title()}</h2>
        <div class="status">Status: {result["status"]}</div>
"""
            
            if result.get("reason"):
                html += f'        <p><em>{result["reason"]}</em></p>'
            
            # Add metrics
            for key, value in result.items():
                if key not in ("status", "reason", "violations"):
                    if isinstance(value, dict):
                        html += f"        <h3>{key.replace('_', ' ').title()}</h3><pre>{json.dumps(value, indent=2)}</pre>"
                    elif isinstance(value, list):
                        pass  # Will be handled below
            
            # Add violations
            if result.get("violations"):
                html += "        <h3>Violations</h3><ul>"
                for violation in result["violations"]:
                    html += f"            <li><span class='violation'>{violation}</span></li>"
                html += "        </ul>"
            
            html += "    </div>\n"
        
        html += """
</body>
</html>
"""
        return html.format(timestamp=datetime.now(timezone.utc).isoformat())


if __name__ == "__main__":
    data_dir = Path(".claude/learning") if not sys.argv[1:] else Path(sys.argv[1])
    runner = TelemetryAuditRunner(data_dir)
    results = runner.run_all_checks()
    
    # Print summary
    print("\n" + "=" * 60)
    print("AUDIT SUMMARY")
    print("=" * 60)
    for check, result in results.items():
        print(f"{check}: {result['status']}")
        if result.get("violations"):
            for v in result["violations"]:
                print(f"  ⚠ {v}")
    
    # Generate HTML report
    report = runner.generate_report()
    report_path = Path("telemetry_audit_report.html")
    report_path.write_text(report)
    print(f"\nDetailed report: {report_path}")
