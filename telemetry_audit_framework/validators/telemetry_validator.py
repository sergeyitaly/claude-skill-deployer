#!/usr/bin/env python3
"""
Telemetry Data Validator
Validates telemetry data for integrity and compliance
"""

import json
from pathlib import Path
from typing import Dict, List, Tuple, Any
from datetime import datetime
import hashlib


class TelemetryDataValidator:
    """Validates telemetry data integrity"""

    def __init__(self, data_path: Path):
        self.data_path = data_path
        self.data = None
        self.errors: List[str] = []
        self.warnings: List[str] = []
        self.stats: Dict[str, Any] = {}

    def load(self) -> bool:
        """Load telemetry data"""
        try:
            with open(self.data_path) as f:
                self.data = json.load(f)
            return True
        except json.JSONDecodeError as e:
            self.errors.append(f"Invalid JSON in {self.data_path}: {e}")
            return False
        except Exception as e:
            self.errors.append(f"Failed to load {self.data_path}: {e}")
            return False

    def validate_structure(self) -> bool:
        """Validate data structure"""
        if not self.data:
            self.errors.append("Telemetry data is empty")
            return False

        if not isinstance(self.data, dict):
            self.errors.append("Telemetry data must be a JSON object")
            return False

        return True

    def validate_required_fields(self) -> bool:
        """Validate required fields present"""
        required = {"timestamp", "event_type", "session_id"}

        for key in required:
            if key not in self.data:
                self.errors.append(f"Missing required field: {key}")

        return len([e for e in self.errors if "Missing required field" in e]) == 0

    def validate_types(self) -> bool:
        """Validate field types"""
        type_checks = [
            ("timestamp", str),
            ("event_type", str),
            ("session_id", str),
        ]

        for field, expected_type in type_checks:
            if field in self.data:
                if not isinstance(self.data[field], expected_type):
                    self.errors.append(
                        f"Field '{field}' must be {expected_type.__name__}, "
                        f"got {type(self.data[field]).__name__}"
                    )

        return len([e for e in self.errors if "must be" in e]) == 0

    def validate_timestamp(self) -> bool:
        """Validate timestamp format"""
        timestamp_str = self.data.get("timestamp")
        if not timestamp_str:
            return True

        try:
            # Try ISO format
            datetime.fromisoformat(timestamp_str.replace("Z", "+00:00"))
            self.stats["timestamp_valid"] = True
            return True
        except ValueError:
            self.errors.append(f"Invalid timestamp format: {timestamp_str}")
            return False

    def validate_event_type(self) -> bool:
        """Validate event type"""
        valid_types = {
            "skill_invoked",
            "skill_used",
            "feature_used",
            "error_occurred",
            "session_started",
            "session_ended",
        }

        event_type = self.data.get("event_type")
        if event_type not in valid_types:
            self.warnings.append(
                f"Unknown event_type '{event_type}'. "
                f"Known types: {valid_types}"
            )

        return True

    def validate_session_id(self) -> bool:
        """Validate session ID format"""
        session_id = self.data.get("session_id")
        if not session_id:
            return True

        # UUID v4 format (optional but recommended)
        if len(session_id) > 100:
            self.warnings.append("Session ID is unusually long")

        # Check for common patterns
        if session_id == "undefined" or session_id == "null":
            self.errors.append(f"Session ID has suspicious value: {session_id}")
            return False

        return True

    def validate_payload(self) -> bool:
        """Validate event payload"""
        if "payload" in self.data:
            if not isinstance(self.data["payload"], dict):
                self.errors.append("Payload must be an object")
                return False

            # Check payload size
            payload_json = json.dumps(self.data["payload"])
            size_kb = len(payload_json.encode()) / 1024

            if size_kb > 100:
                self.warnings.append(
                    f"Payload is large ({size_kb:.1f} KB), "
                    "may impact performance"
                )

        return len([e for e in self.errors if "Payload" in e]) == 0

    def calculate_checksum(self) -> str:
        """Calculate data checksum"""
        if not self.data:
            return ""

        # Create deterministic JSON representation
        json_str = json.dumps(self.data, sort_keys=True)
        return hashlib.sha256(json_str.encode()).hexdigest()

    def validate_all(self) -> Tuple[bool, List[str], List[str], Dict[str, Any]]:
        """Run all validations"""
        if not self.load():
            return False, self.errors, self.warnings, self.stats

        self.validate_structure()
        self.validate_required_fields()
        self.validate_types()
        self.validate_timestamp()
        self.validate_event_type()
        self.validate_session_id()
        self.validate_payload()

        self.stats["checksum"] = self.calculate_checksum()
        self.stats["data_size_bytes"] = len(json.dumps(self.data).encode())

        success = len(self.errors) == 0
        return success, self.errors, self.warnings, self.stats
