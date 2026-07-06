#!/usr/bin/env python3
"""
Schema Validation for Telemetry Audit

Validates that all telemetry records conform to expected schemas.
"""

import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Tuple, Any


class SchemaValidator:
    """Validates telemetry data against expected schemas."""
    
    # Schema definitions
    RUNS_SCHEMA = {
        'required': ['ts', 'skill', 'action', 'rc', 'duration', 'error', 'metadata'],
        'types': {
            'ts': str,
            'skill': str,
            'action': str,
            'rc': int,
            'duration': (int, float),
            'error': str,
            'hint': str,
            'note': str,
            'tokens': int,
            'metadata': dict,
        },
        'optional': ['hint', 'note', 'tokens']
    }
    
    COST_LEARNING_SCHEMA = {
        'required': ['ts', 'skill', 'expected_cost', 'actual_cost', 'success'],
        'types': {
            'ts': str,
            'skill': str,
            'expected_cost': (int, float),
            'actual_cost': (int, float),
            'success': bool,
            'duration': (int, float),
            'tokens_in': int,
            'tokens_out': int,
        },
        'optional': ['duration', 'tokens_in', 'tokens_out']
    }
    
    FEEDBACK_SCHEMA = {
        'required': ['ts', 'skill', 'user_reaction', 'context'],
        'types': {
            'ts': str,
            'skill': str,
            'user_reaction': str,
            'context': str,
            'severity': str,
        },
        'optional': ['severity']
    }
    
    def __init__(self, verbose: bool = False):
        self.verbose = verbose
        self.issues: List[str] = []
        self.warnings: List[str] = []
        
    def validate_timestamp(self, ts: str, line_num: int) -> bool:
        """Validate ISO8601 timestamp format."""
        try:
            datetime.fromisoformat(ts)
            return True
        except (ValueError, TypeError):
            self.issues.append(f"Line {line_num}: Invalid timestamp format: {ts}")
            return False
    
    def validate_field_type(self, value: Any, expected_type: type, field_name: str, line_num: int) -> bool:
        """Validate that value matches expected type."""
        if isinstance(expected_type, tuple):
            # Multiple allowed types
            if not isinstance(value, expected_type):
                self.issues.append(
                    f"Line {line_num}: Field '{field_name}' has wrong type. "
                    f"Expected {expected_type}, got {type(value).__name__}"
                )
                return False
        else:
            if not isinstance(value, expected_type):
                self.issues.append(
                    f"Line {line_num}: Field '{field_name}' has wrong type. "
                    f"Expected {expected_type.__name__}, got {type(value).__name__}"
                )
                return False
        return True
    
    def validate_record(self, record: Dict, schema: Dict, record_type: str, line_num: int) -> bool:
        """Validate a single record against schema."""
        all_valid = True
        
        # Check required fields exist
        for field in schema['required']:
            if field not in record:
                self.issues.append(f"Line {line_num} ({record_type}): Missing required field '{field}'")
                all_valid = False
            else:
                # Validate field type
                if field in schema['types']:
                    expected_type = schema['types'][field]
                    if not self.validate_field_type(record[field], expected_type, field, line_num):
                        all_valid = False
        
        # Check optional fields if present
        for field in schema['optional']:
            if field in record:
                if field in schema['types']:
                    expected_type = schema['types'][field]
                    if not self.validate_field_type(record[field], expected_type, field, line_num):
                        all_valid = False
        
        # Validate special fields
        if 'ts' in record:
            if not self.validate_timestamp(record['ts'], line_num):
                all_valid = False
        
        # Validate specific field constraints
        if 'rc' in record:
            if record['rc'] != 0 and record['rc'] != 1:
                self.warnings.append(f"Line {line_num}: Unexpected rc value: {record['rc']}")
        
        if 'expected_cost' in record or 'actual_cost' in record:
            for cost_field in ['expected_cost', 'actual_cost']:
                if cost_field in record and record[cost_field] < 0:
                    self.issues.append(f"Line {line_num}: Negative {cost_field}: {record[cost_field]}")
                    all_valid = False
        
        return all_valid
    
    def validate_jsonl_file(self, file_path: str, schema: Dict, record_type: str) -> Tuple[int, int]:
        """Validate all records in a JSONL file."""
        if not os.path.exists(file_path):
            self.warnings.append(f"{record_type} file not found: {file_path}")
            return 0, 0
        
        valid_count = 0
        invalid_count = 0
        
        with open(file_path, 'r') as f:
            for line_num, line in enumerate(f, 1):
                if not line.strip():
                    continue
                
                try:
                    record = json.loads(line)
                except json.JSONDecodeError as e:
                    self.issues.append(f"Line {line_num} ({record_type}): Invalid JSON - {e}")
                    invalid_count += 1
                    continue
                
                if self.validate_record(record, schema, record_type, line_num):
                    valid_count += 1
                else:
                    invalid_count += 1
        
        return valid_count, invalid_count
    
    def validate_all(self, data_dir: str) -> Dict[str, Any]:
        """Validate all telemetry data files."""
        results = {
            'timestamp': datetime.now().isoformat(),
            'files': {}
        }
        
        # Validate each file type
        files = {
            'runs.jsonl': (os.path.join(data_dir, 'runs.jsonl'), self.RUNS_SCHEMA, 'runs'),
            'cost-learning.jsonl': (os.path.join(data_dir, 'cost-learning.jsonl'), self.COST_LEARNING_SCHEMA, 'cost-learning'),
            'skill-feedback.jsonl': (os.path.join(data_dir, 'skill-feedback.jsonl'), self.FEEDBACK_SCHEMA, 'feedback'),
        }
        
        for file_name, (file_path, schema, record_type) in files.items():
            valid, invalid = self.validate_jsonl_file(file_path, schema, record_type)
            results['files'][file_name] = {
                'valid': valid,
                'invalid': invalid,
                'total': valid + invalid,
                'compliance': (valid / (valid + invalid) * 100) if (valid + invalid) > 0 else 0
            }
        
        results['summary'] = {
            'total_issues': len(self.issues),
            'total_warnings': len(self.warnings),
            'issues': self.issues[:20],  # First 20
            'warnings': self.warnings[:20]
        }
        
        return results


def main():
    import argparse
    
    parser = argparse.ArgumentParser(
        description='Validate telemetry data schemas'
    )
    parser.add_argument(
        '--data-dir',
        default=os.path.expanduser('~/.claude/learning'),
        help='Directory containing telemetry files'
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
    
    validator = SchemaValidator(verbose=args.verbose)
    results = validator.validate_all(args.data_dir)
    
    # Print results
    print(json.dumps(results, indent=2))
    
    # Save to file if requested
    if args.output:
        with open(args.output, 'w') as f:
            json.dump(results, f, indent=2)
        print(f"\nResults saved to {args.output}")
    
    # Exit with appropriate code
    if results['summary']['total_issues'] > 0:
        sys.exit(1)
    return 0


if __name__ == '__main__':
    sys.exit(main())
