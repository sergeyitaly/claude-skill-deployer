#!/usr/bin/env python3
"""
Telemetry Data Validator
Comprehensive validation and integrity checking for telemetry records
"""

import json
import sys
from pathlib import Path
from datetime import datetime, timedelta
from typing import Dict, List, Any, Tuple, Optional
from collections import defaultdict
import re


class TelemetryValidator:
    """Validates telemetry records against schema and rules"""
    
    # Required fields per record type
    REQUIRED_FIELDS = {
        'skill_invocation': ['timestamp', 'skill_id', 'skill_name', 'session_id', 'user_id', 'context', 'metadata'],
        'skill_feedback': ['timestamp', 'skill_id', 'feedback_type', 'user_id', 'reason'],
        'cost_attribution': ['timestamp', 'skill_id', 'tokens_input', 'tokens_output', 'model_id'],
        'session_start': ['timestamp', 'session_id', 'branch', 'user_profile'],
        'session_end': ['timestamp', 'session_id', 'total_duration_seconds', 'skill_count'],
    }
    
    # Field type constraints
    FIELD_TYPES = {
        'timestamp': str,  # ISO 8601
        'skill_id': str,
        'skill_name': str,
        'session_id': str,
        'user_id': str,
        'tokens_input': int,
        'tokens_output': int,
        'context': dict,
        'metadata': dict,
        'feedback_type': str,
        'reason': str,
        'model_id': str,
        'branch': str,
        'user_profile': str,
        'total_duration_seconds': (int, float),
        'skill_count': int,
    }
    
    # Valid feedback types
    VALID_FEEDBACK_TYPES = {'positive', 'negative', 'neutral', 'correction'}
    
    # Valid record types
    VALID_RECORD_TYPES = set(REQUIRED_FIELDS.keys())
    
    def __init__(self, strict_mode: bool = False):
        self.strict_mode = strict_mode
        self.errors: List[str] = []
        self.warnings: List[str] = []
        self.stats: Dict[str, Any] = defaultdict(int)
    
    def validate_record(self, record: Dict[str, Any], record_type: str) -> bool:
        """Validate a single telemetry record"""
        errors = []
        
        # Check record type
        if record_type not in self.VALID_RECORD_TYPES:
            errors.append(f"Invalid record type: {record_type}")
            self.errors.extend([f"Record {record}: {e}" for e in errors])
            return False
        
        # Check required fields
        required = self.REQUIRED_FIELDS[record_type]
        for field in required:
            if field not in record:
                errors.append(f"Missing required field: {field}")
            else:
                # Validate field type
                if field in self.FIELD_TYPES:
                    expected_type = self.FIELD_TYPES[field]
                    if not isinstance(record[field], expected_type):
                        errors.append(f"Field {field}: expected {expected_type}, got {type(record[field])}")
        
        # Validate specific fields
        if 'timestamp' in record:
            if not self._validate_timestamp(record['timestamp']):
                errors.append(f"Invalid timestamp format: {record['timestamp']}")
        
        if 'feedback_type' in record and record.get('feedback_type') not in self.VALID_FEEDBACK_TYPES:
            errors.append(f"Invalid feedback_type: {record['feedback_type']}")
        
        if 'tokens_input' in record and record.get('tokens_input', 0) < 0:
            errors.append("tokens_input cannot be negative")
        
        if 'tokens_output' in record and record.get('tokens_output', 0) < 0:
            errors.append("tokens_output cannot be negative")
        
        if errors:
            self.errors.extend(errors)
            return False
        
        return True
    
    def _validate_timestamp(self, timestamp: str) -> bool:
        """Validate ISO 8601 timestamp"""
        try:
            datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
            return True
        except (ValueError, AttributeError):
            return False
    
    def validate_file(self, file_path: Path) -> Dict[str, Any]:
        """Validate entire telemetry file"""
        self.errors.clear()
        self.warnings.clear()
        self.stats.clear()
        
        if not file_path.exists():
            return {'valid': False, 'error': f'File not found: {file_path}'}
        
        records = []
        try:
            with open(file_path, 'r') as f:
                for line_no, line in enumerate(f, 1):
                    if not line.strip():
                        continue
                    try:
                        record = json.loads(line)
                        records.append((line_no, record))
                    except json.JSONDecodeError as e:
                        self.errors.append(f"Line {line_no}: JSON decode error: {e}")
        except Exception as e:
            return {'valid': False, 'error': f'File read error: {e}'}
        
        # Validate records
        valid_count = 0
        record_types = defaultdict(int)
        
        for line_no, record in records:
            record_type = record.get('record_type', 'unknown')
            record_types[record_type] += 1
            
            if self.validate_record(record, record_type):
                valid_count += 1
            else:
                if self.strict_mode:
                    self.warnings.append(f"Line {line_no}: Validation issues (see errors)")
        
        self.stats['total_records'] = len(records)
        self.stats['valid_records'] = valid_count
        self.stats['invalid_records'] = len(records) - valid_count
        self.stats['record_types'] = dict(record_types)
        
        return {
            'valid': len(self.errors) == 0,
            'total_records': len(records),
            'valid_records': valid_count,
            'invalid_records': len(records) - valid_count,
            'errors': self.errors[:100],  # First 100 errors
            'warnings': self.warnings[:100],
            'stats': dict(self.stats),
        }
    
    def validate_consistency(self, session_file: Path, cost_file: Path) -> Dict[str, Any]:
        """Validate consistency between session and cost data"""
        issues = []
        
        try:
            sessions = self._load_file(session_file)
            costs = self._load_file(cost_file)
        except Exception as e:
            return {'valid': False, 'error': str(e)}
        
        # Map sessions to skills
        session_skills = defaultdict(set)
        for record in sessions:
            if record.get('record_type') == 'skill_invocation':
                session_skills[record['session_id']].add(record['skill_id'])
        
        # Check cost records reference valid sessions
        cost_sessions = defaultdict(set)
        for record in costs:
            if record.get('record_type') == 'cost_attribution':
                cost_sessions[record.get('session_id', 'unknown')].add(record['skill_id'])
        
        # Validate references
        for session_id, skills in cost_sessions.items():
            if session_id not in session_skills and session_id != 'unknown':
                issues.append(f"Cost record references unknown session: {session_id}")
            else:
                missing_skills = skills - session_skills.get(session_id, set())
                if missing_skills:
                    issues.append(f"Session {session_id}: Cost for unrecorded skills: {missing_skills}")
        
        return {
            'valid': len(issues) == 0,
            'issues': issues,
            'session_count': len(session_skills),
            'cost_session_count': len(cost_sessions),
        }
    
    def _load_file(self, file_path: Path) -> List[Dict]:
        """Load JSONL file"""
        records = []
        with open(file_path, 'r') as f:
            for line in f:
                if line.strip():
                    records.append(json.loads(line))
        return records


class PrivacyValidator:
    """Validates privacy constraints in telemetry data"""
    
    SENSITIVE_PATTERNS = [
        r'password',
        r'token',
        r'secret',
        r'key',
        r'credential',
        r'api_key',
        r'access_token',
    ]
    
    def __init__(self):
        self.violations: List[str] = []
    
    def validate_record(self, record: Dict[str, Any]) -> bool:
        """Check record for sensitive data"""
        self.violations.clear()
        
        # Recursively check all values
        self._check_values(record, path='')
        
        return len(self.violations) == 0
    
    def _check_values(self, obj: Any, path: str = ''):
        """Recursively check for sensitive patterns"""
        if isinstance(obj, dict):
            for key, value in obj.items():
                new_path = f"{path}.{key}" if path else key
                
                # Check key names
                if self._contains_sensitive_pattern(key):
                    self.violations.append(f"Sensitive key at {new_path}: {key}")
                
                self._check_values(value, new_path)
        
        elif isinstance(obj, list):
            for i, item in enumerate(obj):
                new_path = f"{path}[{i}]"
                self._check_values(item, new_path)
        
        elif isinstance(obj, str):
            if self._contains_sensitive_pattern(obj):
                self.violations.append(f"Sensitive string at {path}")
    
    def _contains_sensitive_pattern(self, text: str) -> bool:
        """Check if text matches sensitive patterns"""
        if not isinstance(text, str):
            return False
        
        text_lower = text.lower()
        return any(re.search(pattern, text_lower) for pattern in self.SENSITIVE_PATTERNS)


def main():
    """Run validation suite"""
    if len(sys.argv) < 2:
        print("Usage: telemetry_validator.py <file_path> [--strict]")
        sys.exit(1)
    
    file_path = Path(sys.argv[1])
    strict_mode = '--strict' in sys.argv
    
    # Validate telemetry data
    validator = TelemetryValidator(strict_mode=strict_mode)
    result = validator.validate_file(file_path)
    
    # Validate privacy
    privacy_validator = PrivacyValidator()
    
    with open(file_path, 'r') as f:
        for line in f:
            if line.strip():
                record = json.loads(line)
                if not privacy_validator.validate_record(record):
                    print(f"Privacy violations: {privacy_validator.violations}")
    
    # Output results
    print(json.dumps(result, indent=2))
    
    # Exit code based on validation
    sys.exit(0 if result['valid'] else 1)


if __name__ == '__main__':
    main()
