#!/usr/bin/env python3
"""
Data Integrity Check for Telemetry Audit

Checks for corruption, loss, temporal consistency, duplicates, and cross-references.
"""

import json
import os
import sys
from datetime import datetime
from collections import defaultdict
from typing import Dict, List, Tuple, Set, Any


class IntegrityChecker:
    """Checks integrity of telemetry data."""
    
    def __init__(self, verbose: bool = False):
        self.verbose = verbose
        self.issues: List[str] = []
        self.warnings: List[str] = []
        
    def check_file_completeness(self, file_path: str) -> Tuple[bool, str]:
        """Verify file is not truncated or empty."""
        if not os.path.exists(file_path):
            return False, "File not found"
        
        size = os.path.getsize(file_path)
        if size == 0:
            return False, "Empty file (0 bytes)"
        if size < 50:
            return False, f"Suspiciously small ({size} bytes)"
        
        # Try to read last line to detect truncation
        try:
            with open(file_path, 'rb') as f:
                f.seek(-1, 2)  # Seek to 1 byte before end
                last_char = f.read(1)
                if last_char != b'\n':
                    return False, "File does not end with newline (possible truncation)"
        except OSError:
            pass  # File is very small, skip this check
        
        return True, f"OK ({size} bytes)"
    
    def check_temporal_ordering(self, file_path: str) -> Tuple[List[Tuple[int, str, str]], int]:
        """Verify timestamps are in chronological order."""
        issues = []
        valid_count = 0
        
        if not os.path.exists(file_path):
            return issues, 0
        
        prev_ts = None
        prev_line = None
        
        with open(file_path, 'r') as f:
            for line_num, line in enumerate(f, 1):
                if not line.strip():
                    continue
                
                try:
                    record = json.loads(line)
                    ts_str = record.get('ts')
                    
                    if ts_str:
                        ts = datetime.fromisoformat(ts_str)
                        
                        if prev_ts and ts < prev_ts:
                            issues.append((
                                line_num,
                                f"Timestamp went backwards: {prev_ts} -> {ts}",
                                f"Previous: line {prev_line}"
                            ))
                        
                        prev_ts = ts
                        prev_line = line_num
                        valid_count += 1
                        
                except (json.JSONDecodeError, ValueError):
                    pass
        
        return issues, valid_count
    
    def check_for_duplicates(self, file_path: str) -> Tuple[List[Tuple[int, int]], int]:
        """Detect duplicate records."""
        duplicates = []
        seen = {}
        
        if not os.path.exists(file_path):
            return duplicates, 0
        
        with open(file_path, 'r') as f:
            for line_num, line in enumerate(f, 1):
                if not line.strip():
                    continue
                
                try:
                    record = json.loads(line)
                    
                    # Create composite key
                    ts = record.get('ts', '')
                    skill = record.get('skill', '')
                    action = record.get('action', '')
                    key = (ts, skill, action)
                    
                    if key in seen:
                        duplicates.append((line_num, seen[key]))
                    else:
                        seen[key] = line_num
                        
                except json.JSONDecodeError:
                    pass
        
        return duplicates, len(seen)
    
    def check_cross_references(self, runs_file: str, skills_dir: str) -> List[str]:
        """Verify skill names in runs refer to real skills."""
        issues = []
        
        if not os.path.exists(runs_file):
            return issues
        
        # Load known skills
        known_skills = set()
        if os.path.exists(skills_dir):
            try:
                known_skills = set(os.listdir(skills_dir))
            except OSError:
                return ["Cannot read skills directory"]
        
        known_skills.add('task')  # Allow 'task' as pseudo-skill
        
        unknown_skills = defaultdict(int)
        
        with open(runs_file, 'r') as f:
            for line_num, line in enumerate(f, 1):
                if not line.strip():
                    continue
                
                try:
                    record = json.loads(line)
                    skill = record.get('skill')
                    
                    if skill and skill not in known_skills:
                        unknown_skills[skill] += 1
                        
                except json.JSONDecodeError:
                    pass
        
        # Report unknown skills
        if unknown_skills:
            for skill, count in sorted(unknown_skills.items(), key=lambda x: -x[1]):
                issues.append(f"Unknown skill '{skill}' referenced {count} times")
        
        return issues
    
    def check_field_ranges(self, file_path: str) -> List[str]:
        """Validate that field values are in reasonable ranges."""
        issues = []
        
        if not os.path.exists(file_path):
            return issues
        
        with open(file_path, 'r') as f:
            for line_num, line in enumerate(f, 1):
                if not line.strip():
                    continue
                
                try:
                    record = json.loads(line)
                    
                    # Check duration (should be reasonable, not negative or > 1 hour)
                    duration = record.get('duration')
                    if duration is not None:
                        if duration < 0:
                            issues.append(f"Line {line_num}: Negative duration: {duration}s")
                        elif duration > 3600:
                            issues.append(f"Line {line_num}: Suspiciously long duration: {duration}s (>1 hour)")
                    
                    # Check costs (should be non-negative and reasonable)
                    for cost_field in ['expected_cost', 'actual_cost']:
                        cost = record.get(cost_field)
                        if cost is not None:
                            if cost < 0:
                                issues.append(f"Line {line_num}: Negative {cost_field}: ${cost}")
                            elif cost > 100:
                                issues.append(f"Line {line_num}: Suspiciously high {cost_field}: ${cost}")
                    
                    # Check tokens (should be non-negative and reasonable)
                    for token_field in ['tokens', 'tokens_in', 'tokens_out']:
                        tokens = record.get(token_field)
                        if tokens is not None:
                            if tokens < 0:
                                issues.append(f"Line {line_num}: Negative {token_field}: {tokens}")
                            elif tokens > 1_000_000:
                                issues.append(f"Line {line_num}: Suspiciously high {token_field}: {tokens}")
                        
                except json.JSONDecodeError:
                    pass
        
        return issues
    
    def check_workspace_affinity_integrity(self, file_path: str) -> List[str]:
        """CHECK 7: Validate workspace-affinity.json structure and score ranges."""
        issues = []

        if not os.path.exists(file_path):
            return issues

        try:
            with open(file_path, 'r') as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            return [f"Cannot parse workspace-affinity.json: {e}"]

        if data.get('version') != 1:
            issues.append(f"Unexpected version: {data.get('version')} (expected 1)")

        skills = data.get('skills', {})
        if not isinstance(skills, dict):
            return issues + ["'skills' field is not an object"]

        required_fields = {
            'skill', 'observations', 'manualInvocations', 'recommendationInvocations',
            'successCount', 'reuseCount', 'affinityScore',
        }
        for name, record in skills.items():
            missing = required_fields - set(record.keys())
            if missing:
                issues.append(f"Skill '{name}': missing field(s) {sorted(missing)}")
                continue

            score = record.get('affinityScore')
            if not isinstance(score, (int, float)) or score < 0 or score > 100:
                issues.append(f"Skill '{name}': affinityScore out of range 0-100: {score}")

            for count_field in ('observations', 'manualInvocations', 'recommendationInvocations',
                                 'successCount', 'reuseCount'):
                value = record.get(count_field)
                if not isinstance(value, (int, float)) or value < 0:
                    issues.append(f"Skill '{name}': {count_field} is negative or non-numeric: {value}")

        return issues

    def check_recommendation_boost_validation(self, file_path: str) -> List[str]:
        """CHECK 8: Validate task-skill-proposals.json confidenceBreakdown values."""
        issues = []

        if not os.path.exists(file_path):
            return issues

        try:
            with open(file_path, 'r') as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            return [f"Cannot parse task-skill-proposals.json: {e}"]

        # Workspace affinity boost is a fixed tiered value (Phase 3): 0, 10, 15, or 25.
        valid_workspace_boosts = {0, 10, 15, 25}

        for proposal in data.get('proposals', []):
            breakdown = proposal.get('confidenceBreakdown')
            if not breakdown:
                continue
            name = proposal.get('name', '<unknown>')

            ws_boost = breakdown.get('workspaceAffinity', 0)
            if ws_boost not in valid_workspace_boosts:
                issues.append(
                    f"Proposal '{name}': workspaceAffinity boost {ws_boost} is not a valid tier {sorted(valid_workspace_boosts)}"
                )

            confidence = proposal.get('confidence')
            if isinstance(confidence, (int, float)) and (confidence < 0 or confidence > 100):
                issues.append(f"Proposal '{name}': confidence {confidence} out of range 0-100")

        return issues

    def check_manual_invocation_learning(self, file_path: str) -> List[str]:
        """CHECK 9: Validate invocationSource values in skill-adoption.jsonl."""
        issues = []

        if not os.path.exists(file_path):
            return issues

        valid_sources = {'auto', 'manual', 'recommended', 'profile-init'}

        with open(file_path, 'r') as f:
            for line_num, line in enumerate(f, 1):
                if not line.strip():
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue

                if record.get('event') != 'invoked':
                    continue
                source = record.get('source')
                if source is not None and source not in valid_sources:
                    issues.append(f"Line {line_num}: unknown invocationSource '{source}'")

        return issues

    def check_skill_lifecycle_integrity(self, file_path: str) -> List[str]:
        """CHECK 10: Validate skill-lifecycle.json structure, statuses, and priorities."""
        issues = []

        if not os.path.exists(file_path):
            return issues

        try:
            with open(file_path, 'r') as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            return [f"Cannot parse skill-lifecycle.json: {e}"]

        valid_statuses = {'current', 'outdated', 'deprecated', 'missing'}
        valid_priorities = {'HIGH', 'MEDIUM', 'LOW'}

        for name, record in data.get('skills', {}).items():
            status = record.get('status')
            if status not in valid_statuses:
                issues.append(f"Skill '{name}': invalid status '{status}'")

            priority = record.get('updatePriority')
            if priority not in valid_priorities:
                issues.append(f"Skill '{name}': invalid updatePriority '{priority}'")

            affinity = record.get('affinity')
            if not isinstance(affinity, (int, float)) or affinity < 0 or affinity > 100:
                issues.append(f"Skill '{name}': affinity out of range 0-100: {affinity}")

        return issues

    def check_outdated_skill_prioritization(self, file_path: str) -> List[str]:
        """CHECK 11: Verify outdated/deprecated skills are prioritized by actual impact,
        not just flagged. Re-derives the HIGH/MEDIUM/LOW bucket from priorityScore and
        flags any mismatch — catches drift between the ranking logic and stored priority."""
        issues = []

        if not os.path.exists(file_path):
            return issues

        try:
            with open(file_path, 'r') as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            return [f"Cannot parse skill-lifecycle.json: {e}"]

        def expected_bucket(score: float) -> str:
            if score >= 65:
                return 'HIGH'
            if score >= 35:
                return 'MEDIUM'
            return 'LOW'

        for name, record in data.get('skills', {}).items():
            if record.get('status') not in ('outdated', 'deprecated'):
                continue
            score = record.get('priorityScore')
            priority = record.get('updatePriority')
            if not isinstance(score, (int, float)):
                issues.append(f"Skill '{name}': missing priorityScore for outdated/deprecated skill")
                continue
            expected = expected_bucket(score)
            if priority != expected:
                issues.append(
                    f"Skill '{name}': updatePriority '{priority}' inconsistent with priorityScore {score} (expected '{expected}')"
                )

        return issues

    def check_metadata_fields(self, file_path: str) -> Tuple[int, int]:
        """Check for presence of optional metadata fields."""
        with_metadata = 0
        without_metadata = 0
        
        if not os.path.exists(file_path):
            return 0, 0
        
        with open(file_path, 'r') as f:
            for line in f:
                if not line.strip():
                    continue
                
                try:
                    record = json.loads(line)
                    
                    if 'metadata' in record:
                        with_metadata += 1
                    else:
                        without_metadata += 1
                        
                except json.JSONDecodeError:
                    pass
        
        return with_metadata, without_metadata
    
    def run_all_checks(self, data_dir: str, skills_dir: str) -> Dict[str, Any]:
        """Run all integrity checks."""
        results = {
            'timestamp': datetime.now().isoformat(),
            'checks': {}
        }
        
        # Check file completeness
        for file_name in ['runs.jsonl', 'cost-learning.jsonl', 'skill-feedback.jsonl']:
            file_path = os.path.join(data_dir, file_name)
            ok, msg = self.check_file_completeness(file_path)
            results['checks'][f"completeness_{file_name}"] = {
                'status': 'PASS' if ok else 'FAIL',
                'message': msg
            }
        
        # Check temporal ordering
        runs_file = os.path.join(data_dir, 'runs.jsonl')
        temporal_issues, valid_count = self.check_temporal_ordering(runs_file)
        results['checks']['temporal_ordering'] = {
            'status': 'PASS' if not temporal_issues else 'FAIL',
            'valid_records': valid_count,
            'issues_count': len(temporal_issues),
            'issues': temporal_issues[:5]
        }
        
        # Check for duplicates
        duplicates, unique_count = self.check_for_duplicates(runs_file)
        results['checks']['duplicates'] = {
            'status': 'PASS' if not duplicates else 'WARN',
            'unique_records': unique_count,
            'duplicates_count': len(duplicates),
            'duplicates': duplicates[:5]
        }
        
        # Check cross-references
        xref_issues = self.check_cross_references(runs_file, skills_dir)
        results['checks']['cross_references'] = {
            'status': 'PASS' if not xref_issues else 'WARN',
            'issues_count': len(xref_issues),
            'issues': xref_issues[:5]
        }
        
        # Check field ranges
        range_issues = self.check_field_ranges(runs_file)
        results['checks']['field_ranges'] = {
            'status': 'PASS' if not range_issues else 'WARN',
            'issues_count': len(range_issues),
            'issues': range_issues[:5]
        }
        
        # CHECK 7: Workspace affinity integrity
        affinity_issues = self.check_workspace_affinity_integrity(
            os.path.join(data_dir, 'workspace-affinity.json')
        )
        results['checks']['workspace_affinity_integrity'] = {
            'status': 'PASS' if not affinity_issues else 'WARN',
            'issues_count': len(affinity_issues),
            'issues': affinity_issues[:5],
        }

        # CHECK 8: Recommendation boost validation
        boost_issues = self.check_recommendation_boost_validation(
            os.path.join(data_dir, 'task-skill-proposals.json')
        )
        results['checks']['recommendation_boost_validation'] = {
            'status': 'PASS' if not boost_issues else 'WARN',
            'issues_count': len(boost_issues),
            'issues': boost_issues[:5],
        }

        # CHECK 9: Manual invocation learning
        invocation_issues = self.check_manual_invocation_learning(
            os.path.join(data_dir, 'skill-adoption.jsonl')
        )
        results['checks']['manual_invocation_learning'] = {
            'status': 'PASS' if not invocation_issues else 'WARN',
            'issues_count': len(invocation_issues),
            'issues': invocation_issues[:5],
        }

        # CHECK 10: Skill lifecycle integrity
        lifecycle_file = os.path.join(data_dir, 'skill-lifecycle.json')
        lifecycle_issues = self.check_skill_lifecycle_integrity(lifecycle_file)
        results['checks']['skill_lifecycle_integrity'] = {
            'status': 'PASS' if not lifecycle_issues else 'WARN',
            'issues_count': len(lifecycle_issues),
            'issues': lifecycle_issues[:5],
        }

        # CHECK 11: Outdated skill prioritization
        prioritization_issues = self.check_outdated_skill_prioritization(lifecycle_file)
        results['checks']['outdated_skill_prioritization'] = {
            'status': 'PASS' if not prioritization_issues else 'WARN',
            'issues_count': len(prioritization_issues),
            'issues': prioritization_issues[:5],
        }

        # Check metadata
        with_meta, without_meta = self.check_metadata_fields(runs_file)
        meta_coverage = (with_meta / (with_meta + without_meta) * 100) if (with_meta + without_meta) > 0 else 0
        results['checks']['metadata_coverage'] = {
            'status': 'PASS' if meta_coverage >= 90 else 'WARN',
            'with_metadata': with_meta,
            'without_metadata': without_meta,
            'coverage_percent': meta_coverage
        }
        
        # Summary
        results['summary'] = {
            'total_checks': len(results['checks']),
            'passed': sum(1 for c in results['checks'].values() if c['status'] == 'PASS'),
            'warnings': sum(1 for c in results['checks'].values() if c['status'] == 'WARN'),
            'failed': sum(1 for c in results['checks'].values() if c['status'] == 'FAIL'),
        }
        
        return results


def main():
    import argparse
    
    parser = argparse.ArgumentParser(
        description='Check telemetry data integrity'
    )
    parser.add_argument(
        '--data-dir',
        default=os.path.expanduser('~/.claude/learning'),
        help='Directory containing telemetry files'
    )
    parser.add_argument(
        '--skills-dir',
        default=os.path.expanduser('~/.claude/skills'),
        help='Directory containing installed skills'
    )
    parser.add_argument(
        '--output',
        help='Output JSON file for results'
    )
    parser.add_argument(
        '-v', '--verbose',
        action='store_true',
        help='Verbose output'
    )
    
    args = parser.parse_args()
    
    checker = IntegrityChecker(verbose=args.verbose)
    results = checker.run_all_checks(args.data_dir, args.skills_dir)
    
    # Print results
    print(json.dumps(results, indent=2))
    
    # Save to file if requested
    if args.output:
        with open(args.output, 'w') as f:
            json.dump(results, f, indent=2)
        print(f"\nResults saved to {args.output}")
    
    # Exit with code based on results
    failed = results['summary']['failed']
    sys.exit(1 if failed > 0 else 0)


if __name__ == '__main__':
    sys.exit(main())
