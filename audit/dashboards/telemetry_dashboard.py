#!/usr/bin/env python3
"""
Telemetry Dashboard - Real-time monitoring and visualization of telemetry health
"""

import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Any, Optional
from dataclasses import dataclass, asdict
from collections import defaultdict
import statistics

@dataclass
class DashboardMetric:
    """A single dashboard metric"""
    name: str
    value: Any
    unit: str
    status: str  # green, yellow, red
    timestamp: str
    details: Optional[Dict[str, Any]] = None

class TelemetryDashboard:
    """Real-time telemetry dashboard"""
    
    def __init__(self, config_path: Path):
        self.config_path = config_path
        self.metrics: List[DashboardMetric] = []
        self.load_config()
    
    def load_config(self):
        """Load dashboard configuration"""
        if self.config_path.exists():
            with open(self.config_path) as f:
                self.config = json.load(f)
        else:
            self.config = self._default_config()
    
    def _default_config(self) -> Dict[str, Any]:
        """Default dashboard configuration"""
        return {
            "metrics": [
                {
                    "id": "data_freshness",
                    "name": "Data Freshness",
                    "description": "How recent is the telemetry data",
                    "thresholds": {
                        "green": 3600,      # 1 hour
                        "yellow": 86400,    # 1 day
                        "red": 604800       # 7 days
                    }
                },
                {
                    "id": "collection_rate",
                    "name": "Collection Rate",
                    "description": "Percentage of sessions with valid telemetry",
                    "thresholds": {
                        "green": 0.95,
                        "yellow": 0.80,
                        "red": 0.50
                    }
                },
                {
                    "id": "data_quality_score",
                    "name": "Data Quality Score",
                    "description": "Overall quality of collected telemetry",
                    "thresholds": {
                        "green": 0.90,
                        "yellow": 0.75,
                        "red": 0.50
                    }
                },
                {
                    "id": "error_rate",
                    "name": "Error Rate",
                    "description": "Percentage of records with errors",
                    "thresholds": {
                        "red": 0.10,
                        "yellow": 0.05,
                        "green": 0.01
                    }
                },
                {
                    "id": "attribution_accuracy",
                    "name": "Attribution Accuracy",
                    "description": "Accuracy of skill attribution",
                    "thresholds": {
                        "green": 0.95,
                        "yellow": 0.85,
                        "red": 0.70
                    }
                }
            ],
            "refresh_interval": 300,  # 5 minutes
            "retention_days": 30
        }
    
    def add_metric(self, metric: DashboardMetric):
        """Add a metric to the dashboard"""
        self.metrics.append(metric)
    
    def determine_status(self, metric_id: str, value: Any) -> str:
        """Determine metric status based on thresholds"""
        config_metric = next(
            (m for m in self.config["metrics"] if m["id"] == metric_id),
            None
        )
        
        if not config_metric:
            return "unknown"
        
        thresholds = config_metric["thresholds"]
        
        # For metrics where higher is better
        if metric_id in ["collection_rate", "data_quality_score", "attribution_accuracy"]:
            if value >= thresholds.get("green", 1.0):
                return "green"
            elif value >= thresholds.get("yellow", 0.5):
                return "yellow"
            else:
                return "red"
        
        # For metrics where lower is better
        elif metric_id in ["error_rate"]:
            if value <= thresholds.get("green", 0.01):
                return "green"
            elif value <= thresholds.get("yellow", 0.05):
                return "yellow"
            else:
                return "red"
        
        # For time-based metrics (freshness)
        elif metric_id == "data_freshness":
            if value <= thresholds.get("green", 3600):
                return "green"
            elif value <= thresholds.get("yellow", 86400):
                return "yellow"
            else:
                return "red"
        
        return "unknown"
    
    def calculate_metrics(self, telemetry_data: Dict[str, Any]) -> List[DashboardMetric]:
        """Calculate all dashboard metrics"""
        metrics = []
        
        # Data Freshness
        if telemetry_data.get("latest_timestamp"):
            latest = datetime.fromisoformat(telemetry_data["latest_timestamp"])
            now = datetime.utcnow()
            freshness_seconds = (now - latest).total_seconds()
            status = self.determine_status("data_freshness", freshness_seconds)
            metrics.append(DashboardMetric(
                name="Data Freshness",
                value=int(freshness_seconds),
                unit="seconds",
                status=status,
                timestamp=now.isoformat(),
                details={
                    "last_update": telemetry_data["latest_timestamp"],
                    "age": str(timedelta(seconds=int(freshness_seconds)))
                }
            ))
        
        # Collection Rate
        if telemetry_data.get("total_sessions", 0) > 0:
            valid_sessions = telemetry_data.get("valid_records", 0)
            collection_rate = valid_sessions / telemetry_data["total_sessions"]
            status = self.determine_status("collection_rate", collection_rate)
            metrics.append(DashboardMetric(
                name="Collection Rate",
                value=round(collection_rate * 100, 2),
                unit="%",
                status=status,
                timestamp=datetime.utcnow().isoformat(),
                details={
                    "valid_sessions": valid_sessions,
                    "total_sessions": telemetry_data["total_sessions"]
                }
            ))
        
        # Data Quality Score
        quality_scores = []
        if telemetry_data.get("validation_results"):
            results = telemetry_data["validation_results"]
            quality_scores.append(results.get("schema_compliance", 0))
            quality_scores.append(results.get("data_completeness", 0))
            quality_scores.append(results.get("timestamp_validity", 0))
            quality_scores.append(results.get("type_correctness", 0))
        
        if quality_scores:
            quality_score = statistics.mean(quality_scores)
            status = self.determine_status("data_quality_score", quality_score)
            metrics.append(DashboardMetric(
                name="Data Quality Score",
                value=round(quality_score * 100, 2),
                unit="%",
                status=status,
                timestamp=datetime.utcnow().isoformat(),
                details={
                    "schema_compliance": telemetry_data.get("validation_results", {}).get("schema_compliance", 0),
                    "data_completeness": telemetry_data.get("validation_results", {}).get("data_completeness", 0),
                    "timestamp_validity": telemetry_data.get("validation_results", {}).get("timestamp_validity", 0),
                    "type_correctness": telemetry_data.get("validation_results", {}).get("type_correctness", 0)
                }
            ))
        
        # Error Rate
        if telemetry_data.get("total_records", 0) > 0:
            error_records = telemetry_data.get("error_count", 0)
            error_rate = error_records / telemetry_data["total_records"]
            status = self.determine_status("error_rate", error_rate)
            metrics.append(DashboardMetric(
                name="Error Rate",
                value=round(error_rate * 100, 2),
                unit="%",
                status=status,
                timestamp=datetime.utcnow().isoformat(),
                details={
                    "error_records": error_records,
                    "total_records": telemetry_data["total_records"]
                }
            ))
        
        # Attribution Accuracy
        if telemetry_data.get("attribution_stats"):
            stats = telemetry_data["attribution_stats"]
            if stats.get("total_attributions", 0) > 0:
                accuracy = stats.get("correct_attributions", 0) / stats["total_attributions"]
                status = self.determine_status("attribution_accuracy", accuracy)
                metrics.append(DashboardMetric(
                    name="Attribution Accuracy",
                    value=round(accuracy * 100, 2),
                    unit="%",
                    status=status,
                    timestamp=datetime.utcnow().isoformat(),
                    details=stats
                ))
        
        return metrics
    
    def generate_html_dashboard(self, metrics: List[DashboardMetric]) -> str:
        """Generate HTML dashboard visualization"""
        html = """
<!DOCTYPE html>
<html>
<head>
    <title>Telemetry Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; background: #f5f5f5; padding: 20px; }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { margin-bottom: 30px; }
        .header h1 { color: #333; margin-bottom: 10px; }
        .header p { color: #666; font-size: 14px; }
        .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
        .metric-card { background: white; border-radius: 8px; padding: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .metric-card.green { border-top: 4px solid #4caf50; }
        .metric-card.yellow { border-top: 4px solid #ff9800; }
        .metric-card.red { border-top: 4px solid #f44336; }
        .metric-name { color: #666; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px; }
        .metric-value { font-size: 32px; font-weight: bold; color: #333; margin-bottom: 10px; }
        .metric-unit { color: #999; font-size: 14px; }
        .metric-status { display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; margin-top: 10px; }
        .metric-status.green { background: #e8f5e9; color: #2e7d32; }
        .metric-status.yellow { background: #fff3e0; color: #e65100; }
        .metric-status.red { background: #ffebee; color: #c62828; }
        .metric-details { margin-top: 15px; padding-top: 15px; border-top: 1px solid #eee; font-size: 12px; color: #999; }
        .detail-row { display: flex; justify-content: space-between; margin-bottom: 5px; }
        .footer { margin-top: 30px; text-align: center; color: #999; font-size: 12px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Telemetry Health Dashboard</h1>
            <p>Last updated: """ + datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S UTC") + """</p>
        </div>
        <div class="metrics-grid">
"""
        
        for metric in metrics:
            html += f"""
        <div class="metric-card {metric.status}">
            <div class="metric-name">{metric.name}</div>
            <div class="metric-value">{metric.value}<span class="metric-unit">{metric.unit}</span></div>
            <div class="metric-status {metric.status}">{metric.status.upper()}</div>
"""
            if metric.details:
                html += """            <div class="metric-details">"""
                for key, value in metric.details.items():
                    # Format key for display
                    display_key = key.replace("_", " ").title()
                    html += f"""
                <div class="detail-row">
                    <span>{display_key}:</span>
                    <span>{value}</span>
                </div>
"""
                html += """            </div>"""
            
            html += """        </div>
"""
        
        html += """
        </div>
        <div class="footer">
            <p>Claude Skills Deployer - Telemetry Monitoring</p>
        </div>
    </div>
</body>
</html>
"""
        return html
    
    def save_metrics(self, metrics: List[DashboardMetric], output_path: Path):
        """Save metrics to JSON"""
        data = {
            "timestamp": datetime.utcnow().isoformat(),
            "metrics": [asdict(m) for m in metrics]
        }
        with open(output_path, 'w') as f:
            json.dump(data, f, indent=2)
    
    def print_text_dashboard(self, metrics: List[DashboardMetric]):
        """Print text-based dashboard to console"""
        print("\n" + "=" * 60)
        print("TELEMETRY HEALTH DASHBOARD".center(60))
        print("=" * 60)
        print(f"Updated: {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC')}\n")
        
        for metric in metrics:
            status_symbol = {
                "green": "✓",
                "yellow": "⚠",
                "red": "✗"
            }.get(metric.status, "?")
            
            print(f"{status_symbol} {metric.name}")
            print(f"  Value: {metric.value} {metric.unit}")
            print(f"  Status: {metric.status.upper()}")
            
            if metric.details:
                for key, value in metric.details.items():
                    display_key = key.replace("_", " ").title()
                    print(f"  {display_key}: {value}")
            print()


def main():
    """Main dashboard function"""
    import argparse
    
    parser = argparse.ArgumentParser(description="Telemetry Dashboard")
    parser.add_argument("--config", type=Path, default=Path("audit/config/dashboard.json"),
                        help="Dashboard configuration file")
    parser.add_argument("--telemetry-data", type=Path, help="Telemetry data file")
    parser.add_argument("--output-html", type=Path, help="Output HTML file")
    parser.add_argument("--output-json", type=Path, help="Output JSON metrics file")
    
    args = parser.parse_args()
    
    dashboard = TelemetryDashboard(args.config)
    
    # Load telemetry data
    telemetry_data = {}
    if args.telemetry_data and args.telemetry_data.exists():
        with open(args.telemetry_data) as f:
            telemetry_data = json.load(f)
    
    # Calculate metrics
    metrics = dashboard.calculate_metrics(telemetry_data)
    
    # Print text dashboard
    dashboard.print_text_dashboard(metrics)
    
    # Save HTML if requested
    if args.output_html:
        html = dashboard.generate_html_dashboard(metrics)
        args.output_html.parent.mkdir(parents=True, exist_ok=True)
        with open(args.output_html, 'w') as f:
            f.write(html)
        print(f"\nHTML dashboard saved to: {args.output_html}")
    
    # Save JSON if requested
    if args.output_json:
        args.output_json.parent.mkdir(parents=True, exist_ok=True)
        dashboard.save_metrics(metrics, args.output_json)
        print(f"JSON metrics saved to: {args.output_json}")


if __name__ == "__main__":
    main()
