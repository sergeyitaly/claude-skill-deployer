#!/usr/bin/env python3
"""
Master Telemetry Audit Runner
Coordinates all validation scripts and produces comprehensive audit report
"""

import json
import os
import sys
import subprocess
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Any, Optional
import logging


class TelemetryAuditRunner:
    """Orchestrates telemetry audit operations"""
    
    def __init__(self, data_dir: Optional[str] = None, skills_dir: Optional[str] = None):
        self.data_dir = Path(data_dir or os.path.expanduser('~/.claude/learning'))
        self.skills_dir = Path(skills_dir or os.path.expanduser('~/.claude/skills'))
        self.script_dir = Path(__file__).parent
        
        # Setup logging
        logging.basicConfig(
            level=logging.INFO,
            format='%(asctime)s - %(levelname)s - %(message)s'
        )
        self.logger = logging.getLogger(__name__)
        
        self.results: Dict[str, Any] = {
            'timestamp': datetime.now().isoformat(),
            'audit_stage': 'INIT',
            'stages': {},
            'summary': {}
        }
    
    def run_schema_validation(self) -> bool:
        """Run schema validation"""
        self.logger.info("Stage 1: Running schema validation...")
        
        script = self.script_dir / 'audit_validate_schema.py'
        if not script.exists():
            self.logger.error(f"Schema validation script not found: {script}")
            return False
        
        try:
            output_file = self.data_dir / '.audit_schema_result.json'
            cmd = [
                sys.executable, str(script),
                '--data-dir', str(self.data_dir),
                '--output', str(output_file)
            ]
            
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            
            if result.returncode != 0:
                self.logger.warning(f"Schema validation had issues: {result.stderr}")
            
            # Load results
            if output_file.exists():
                with open(output_file) as f:
                    self.results['stages']['schema_validation'] = json.load(f)
                output_file.unlink()  # Clean up temp file
            
            self.logger.info("✓ Schema validation complete")
            return True
            
        except subprocess.TimeoutExpired:
            self.logger.error("Schema validation timeout")
            return False
        except Exception as e:
            self.logger.error(f"Schema validation error: {e}")
            return False
    
    def run_integrity_check(self) -> bool:
        """Run integrity checks"""
        self.logger.info("Stage 2: Running integrity checks...")
        
        script = self.script_dir / 'audit_check_integrity.py'
        if not script.exists():
            self.logger.error(f"Integrity check script not found: {script}")
            return False
        
        try:
            output_file = self.data_dir / '.audit_integrity_result.json'
            cmd = [
                sys.executable, str(script),
                '--data-dir', str(self.data_dir),
                '--skills-dir', str(self.skills_dir),
                '--output', str(output_file)
            ]
            
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            
            if result.returncode != 0:
                self.logger.warning(f"Integrity checks had issues: {result.stderr}")
            
            # Load results
            if output_file.exists():
                with open(output_file) as f:
                    self.results['stages']['integrity_check'] = json.load(f)
                output_file.unlink()
            
            self.logger.info("✓ Integrity checks complete")
            return True
            
        except subprocess.TimeoutExpired:
            self.logger.error("Integrity checks timeout")
            return False
        except Exception as e:
            self.logger.error(f"Integrity check error: {e}")
            return False
    
    def run_privacy_validation(self) -> bool:
        """Run privacy validation"""
        self.logger.info("Stage 3: Running privacy validation...")
        
        script = self.script_dir / 'telemetry_validator.py'
        if not script.exists():
            self.logger.error(f"Privacy validation script not found: {script}")
            return False
        
        try:
            runs_file = self.data_dir / 'runs.jsonl'
            if not runs_file.exists():
                self.logger.warning(f"No runs.jsonl file to validate: {runs_file}")
                return True
            
            cmd = [sys.executable, str(script), str(runs_file), '--strict']
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            
            try:
                validation_result = json.loads(result.stdout)
                self.results['stages']['privacy_validation'] = validation_result
            except json.JSONDecodeError:
                self.logger.warning("Could not parse privacy validation output")
                return False
            
            self.logger.info("✓ Privacy validation complete")
            return True
            
        except subprocess.TimeoutExpired:
            self.logger.error("Privacy validation timeout")
            return False
        except Exception as e:
            self.logger.error(f"Privacy validation error: {e}")
            return False
    
    def run_manifest_validation(self) -> bool:
        """Run manifest validation"""
        self.logger.info("Stage 4: Running manifest validation...")
        
        if not self.skills_dir.exists():
            self.logger.warning(f"Skills directory not found: {self.skills_dir}")
            return True
        
        manifest_path = self.skills_dir / 'manifest.json'
        if not manifest_path.exists():
            self.logger.warning(f"No manifest.json found: {manifest_path}")
            return True
        
        try:
            with open(manifest_path) as f:
                manifest = json.load(f)
            
            # Basic validation
            issues = []
            if not isinstance(manifest, dict):
                issues.append("Manifest must be a JSON object")
            
            if not manifest.get('skills'):
                issues.append("No 'skills' field in manifest")
            
            self.results['stages']['manifest_validation'] = {
                'valid': len(issues) == 0,
                'issues': issues,
                'manifest_path': str(manifest_path)
            }
            
            self.logger.info("✓ Manifest validation complete")
            return True
            
        except Exception as e:
            self.logger.error(f"Manifest validation error: {e}")
            return False
    
    def generate_summary(self) -> None:
        """Generate audit summary"""
        self.logger.info("Generating audit summary...")
        
        summary = {
            'audit_timestamp': self.results['timestamp'],
            'stages_completed': len(self.results['stages']),
            'stages': {}
        }
        
        # Aggregate stage results
        for stage_name, stage_result in self.results['stages'].items():
            if isinstance(stage_result, dict):
                stage_valid = stage_result.get('valid', stage_result.get('status', 'UNKNOWN'))
                summary['stages'][stage_name] = {
                    'status': 'PASS' if stage_valid in ['PASS', True] else 'FAIL',
                    'details_available': 'summary' in stage_result or 'checks' in stage_result
                }
        
        # Overall status
        all_pass = all(
            v['status'] == 'PASS' for v in summary['stages'].values()
        )
        summary['overall_status'] = 'PASS' if all_pass else 'FAIL'
        summary['audit_required_action'] = not all_pass
        
        self.results['summary'] = summary
    
    def run_all_audits(self) -> Dict[str, Any]:
        """Run complete audit suite"""
        self.logger.info("=" * 60)
        self.logger.info("Starting Telemetry Audit Runner")
        self.logger.info("=" * 60)
        self.logger.info(f"Data directory: {self.data_dir}")
        self.logger.info(f"Skills directory: {self.skills_dir}")
        
        # Run all stages
        stages = [
            ('schema_validation', self.run_schema_validation),
            ('integrity_check', self.run_integrity_check),
            ('privacy_validation', self.run_privacy_validation),
            ('manifest_validation', self.run_manifest_validation),
        ]
        
        completed = 0
        for stage_name, stage_func in stages:
            try:
                if stage_func():
                    completed += 1
            except Exception as e:
                self.logger.error(f"Error in {stage_name}: {e}")
        
        self.logger.info(f"\nCompleted {completed}/{len(stages)} audit stages")
        
        # Generate summary
        self.generate_summary()
        
        self.logger.info("=" * 60)
        self.logger.info("Audit Complete")
        self.logger.info("=" * 60)
        
        return self.results
    
    def save_results(self, output_path: Optional[str] = None) -> str:
        """Save audit results to file"""
        if not output_path:
            output_path = str(self.data_dir / f"audit_results_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json")
        
        with open(output_path, 'w') as f:
            json.dump(self.results, f, indent=2)
        
        self.logger.info(f"Audit results saved to: {output_path}")
        return output_path


def main():
    """Main entry point"""
    import argparse
    
    parser = argparse.ArgumentParser(
        description='Run comprehensive telemetry audit'
    )
    parser.add_argument(
        '--data-dir',
        help='Telemetry data directory (default: ~/.claude/learning)'
    )
    parser.add_argument(
        '--skills-dir',
        help='Skills directory (default: ~/.claude/skills)'
    )
    parser.add_argument(
        '--output',
        help='Output file for audit results'
    )
    parser.add_argument(
        '-v', '--verbose',
        action='store_true',
        help='Verbose output'
    )
    
    args = parser.parse_args()
    
    runner = TelemetryAuditRunner(
        data_dir=args.data_dir,
        skills_dir=args.skills_dir
    )
    
    results = runner.run_all_audits()
    output_file = runner.save_results(args.output)
    
    # Print summary
    print("\n" + "=" * 60)
    print("AUDIT SUMMARY")
    print("=" * 60)
    for stage, result in results['summary'].get('stages', {}).items():
        status_icon = "✓" if result['status'] == 'PASS' else "✗"
        print(f"{status_icon} {stage}: {result['status']}")
    
    print(f"\nOverall Status: {results['summary'].get('overall_status', 'UNKNOWN')}")
    print(f"Results saved to: {output_file}")
    
    # Exit with appropriate code
    sys.exit(0 if results['summary'].get('overall_status') == 'PASS' else 1)


if __name__ == '__main__':
    sys.exit(main())
