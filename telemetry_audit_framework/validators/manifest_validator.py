#!/usr/bin/env python3
"""
Manifest Validator
Validates manifest.json against schema and integrity rules
"""

import json
from pathlib import Path
from typing import Dict, List, Tuple, Any
import re


class ManifestValidator:
    """Validates manifest.json structure and content"""

    REQUIRED_FIELDS = {"name", "version", "description"}
    OPTIONAL_FIELDS = {"detect_globs", "keywords", "author"}

    def __init__(self, manifest_path: Path):
        self.manifest_path = manifest_path
        self.manifest = None
        self.errors: List[str] = []
        self.warnings: List[str] = []

    def load(self) -> bool:
        """Load and parse manifest"""
        try:
            with open(self.manifest_path) as f:
                self.manifest = json.load(f)
            return True
        except json.JSONDecodeError as e:
            self.errors.append(f"Invalid JSON: {e}")
            return False
        except Exception as e:
            self.errors.append(f"Failed to load manifest: {e}")
            return False

    def validate_structure(self) -> bool:
        """Validate manifest structure"""
        if not self.manifest:
            self.errors.append("Manifest is empty")
            return False

        # Check required fields
        missing = self.REQUIRED_FIELDS - set(self.manifest.keys())
        if missing:
            self.errors.append(f"Missing required fields: {missing}")
            return False

        # Check for unknown fields
        known = self.REQUIRED_FIELDS | self.OPTIONAL_FIELDS
        unknown = set(self.manifest.keys()) - known
        if unknown:
            self.warnings.append(f"Unknown fields: {unknown}")

        return len(self.errors) == 0

    def validate_types(self) -> bool:
        """Validate field types"""
        if not self.manifest:
            return False

        checks = [
            ("name", str),
            ("version", str),
            ("description", str),
        ]

        for field, expected_type in checks:
            if field in self.manifest:
                if not isinstance(self.manifest[field], expected_type):
                    self.errors.append(
                        f"Field '{field}' must be {expected_type.__name__}, "
                        f"got {type(self.manifest[field]).__name__}"
                    )

        if "detect_globs" in self.manifest:
            if not isinstance(self.manifest["detect_globs"], list):
                self.errors.append("Field 'detect_globs' must be a list")
            elif not all(isinstance(g, str) for g in self.manifest["detect_globs"]):
                self.errors.append("All items in 'detect_globs' must be strings")

        return len(self.errors) == 0

    def validate_version(self) -> bool:
        """Validate semantic version format"""
        version = self.manifest.get("version", "")
        pattern = r"^\d+\.\d+\.\d+(-[a-zA-Z0-9]+)?$"

        if not re.match(pattern, version):
            self.errors.append(
                f"Invalid version format '{version}'. Must be semantic (e.g., 1.0.0)"
            )
            return False

        return True

    def validate_globs(self) -> bool:
        """Validate glob patterns"""
        globs = self.manifest.get("detect_globs", [])

        for glob_pattern in globs:
            # Basic glob validation
            if not glob_pattern:
                self.errors.append("Empty glob pattern detected")
                continue

            # Check for common issues
            if glob_pattern.startswith("/"):
                self.warnings.append(
                    f"Glob pattern '{glob_pattern}' starts with '/', "
                    "should be relative"
                )

        return len(self.errors) == 0

    def validate_description(self) -> bool:
        """Validate description field"""
        description = self.manifest.get("description", "")

        if not description:
            self.errors.append("Description cannot be empty")
            return False

        if len(description) < 10:
            self.warnings.append("Description is very short (< 10 chars)")

        if len(description) > 500:
            self.warnings.append("Description is very long (> 500 chars)")

        return len(self.errors) == 0

    def validate_all(self) -> Tuple[bool, List[str], List[str]]:
        """Run all validations"""
        if not self.load():
            return False, self.errors, self.warnings

        self.validate_structure()
        self.validate_types()
        self.validate_version()
        self.validate_globs()
        self.validate_description()

        success = len(self.errors) == 0
        return success, self.errors, self.warnings
