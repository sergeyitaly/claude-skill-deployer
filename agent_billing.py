"""Fetch real billing/usage from agent provider APIs (stdlib HTTP only, no LLM)."""

from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

AgentId = Literal["claude", "cursor", "kiro", "copilot"]
DataKind = Literal["invoice_usd", "subscription_seats", "usage_only", "unavailable"]


@dataclass
class ModelCostLine:
    model: str
    cost_usd: float
    tokens: int = 0


@dataclass
class AgentBillingResult:
    agent: AgentId
    display_name: str
    status: Literal["ok", "skipped", "error"]
    kind: DataKind
    cost_usd: float | None = None
    currency: str = "USD"
    period_days: int = 7
    message: str = ""
    models: list[ModelCostLine] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)
    source: str = ""


def _utc_day_bounds(days_back: int) -> tuple[str, str]:
    end = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    start = end - timedelta(days=days_back)
    return start.strftime("%Y-%m-%dT%H:%M:%SZ"), end.strftime("%Y-%m-%dT%H:%M:%SZ")


def _http_json(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    params: dict[str, Any] | None = None,
    body: dict[str, Any] | None = None,
    timeout: int = 45,
) -> Any:
    hdrs = dict(headers or {})
    if body is not None and "Content-Type" not in hdrs:
        hdrs["Content-Type"] = "application/json"

    full_url = url
    if params:
        flat: list[tuple[str, str]] = []
        for key, value in params.items():
            if isinstance(value, list):
                for item in value:
                    flat.append((f"{key}[]", str(item)))
            elif value is not None:
                flat.append((key, str(value)))
        full_url = f"{url}?{urllib.parse.urlencode(flat)}"

    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")

    req = urllib.request.Request(full_url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"HTTP {exc.code} {exc.reason}: {detail}") from exc


def _paginate_get(
    url: str,
    *,
    headers: dict[str, str],
    params: dict[str, Any],
    page_key: str = "page",
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    page = params.get(page_key)
    while True:
        payload = _http_json(url, headers=headers, params=params)
        if isinstance(payload, list):
            return payload
        if not isinstance(payload, dict):
            break
        data = payload.get("data")
        if isinstance(data, list):
            rows.extend(data)
        if not payload.get("has_more"):
            break
        next_page = payload.get("next_page")
        if not next_page:
            break
        params = {**params, page_key: next_page}
    return rows


def _amount_to_usd(amount: Any) -> float:
    try:
        return float(amount) / 100.0
    except (TypeError, ValueError):
        return 0.0


class AnthropicBillingClient:
    """Claude agent — Anthropic Usage & Cost Admin API (Console org API usage)."""

    BASE = "https://api.anthropic.com/v1/organizations"

    def __init__(self, api_key: str | None = None) -> None:
        key = api_key or os.getenv("ANTHROPIC_ADMIN_API_KEY") or os.getenv("ANTHROPIC_ADMIN_KEY")
        if not key:
            raise ValueError("missing ANTHROPIC_ADMIN_API_KEY")
        if not key.startswith("sk-ant-admin"):
            raise ValueError("ANTHROPIC_ADMIN_API_KEY must start with sk-ant-admin")
        self.headers = {
            "anthropic-version": "2023-06-01",
            "x-api-key": key,
            "Accept": "application/json",
        }

    def cost_report(self, days_back: int = 7) -> dict[str, Any]:
        start, end = _utc_day_bounds(days_back)
        params: dict[str, Any] = {
            "starting_at": start,
            "ending_at": end,
            "bucket_width": "1d",
            "limit": min(max(days_back, 1), 31),
            "group_by": ["workspace_id", "description"],
        }
        return _http_json(f"{self.BASE}/cost_report", headers=self.headers, params=params)

    def usage_report(self, days_back: int = 7) -> dict[str, Any]:
        start, end = _utc_day_bounds(days_back)
        params: dict[str, Any] = {
            "starting_at": start,
            "ending_at": end,
            "bucket_width": "1d",
            "limit": min(max(days_back, 1), 31),
            "group_by": ["model"],
        }
        return _http_json(f"{self.BASE}/usage_report/messages", headers=self.headers, params=params)


def fetch_claude_billing(days_back: int = 7) -> AgentBillingResult:
    display = "Claude Code / Anthropic API"
    try:
        client = AnthropicBillingClient()
    except ValueError as exc:
        return AgentBillingResult(
            agent="claude",
            display_name=display,
            status="skipped",
            kind="unavailable",
            period_days=days_back,
            message=str(exc),
            source="anthropic_admin_api",
        )

    try:
        cost_payload = client.cost_report(days_back)
        usage_payload = client.usage_report(days_back)
    except RuntimeError as exc:
        return AgentBillingResult(
            agent="claude",
            display_name=display,
            status="error",
            kind="unavailable",
            period_days=days_back,
            message=str(exc),
            source="anthropic_admin_api",
        )

    total_usd = 0.0
    by_model_cost: dict[str, float] = {}
    for bucket in cost_payload.get("data") or []:
        for row in bucket.get("results") or []:
            usd = _amount_to_usd(row.get("amount"))
            total_usd += usd
            model = row.get("model") or row.get("description") or "unknown"
            by_model_cost[str(model)] = by_model_cost.get(str(model), 0.0) + usd

    by_model_tokens: dict[str, int] = {}
    for bucket in usage_payload.get("data") or []:
        for row in bucket.get("results") or []:
            model = str(row.get("model") or "unknown")
            tokens = int(row.get("uncached_input_tokens") or 0) + int(row.get("output_tokens") or 0)
            cache = row.get("cache_creation") or {}
            tokens += int(cache.get("ephemeral_1h_input_tokens") or 0) + int(
                cache.get("ephemeral_5m_input_tokens") or 0
            )
            tokens += int(row.get("cache_read_input_tokens") or 0)
            by_model_tokens[model] = by_model_tokens.get(model, 0) + tokens

    models = [
        ModelCostLine(
            model=m,
            cost_usd=round(by_model_cost.get(m, 0.0), 6),
            tokens=by_model_tokens.get(m, 0),
        )
        for m in sorted(set(by_model_cost) | set(by_model_tokens), key=lambda x: by_model_cost.get(x, 0), reverse=True)
    ]

    return AgentBillingResult(
        agent="claude",
        display_name=display,
        status="ok",
        kind="invoice_usd",
        cost_usd=round(total_usd, 4),
        period_days=days_back,
        message="Anthropic Admin API cost_report (API org usage, not Claude Max/Pro subscription).",
        models=models,
        source="anthropic_admin_api",
        extra={"org_endpoint": "GET /v1/organizations/cost_report"},
    )


class CursorBillingClient:
    """Cursor agent — official Teams Admin API (Business/Enterprise)."""

    BASE = "https://api.cursor.com"

    def __init__(self, api_key: str | None = None) -> None:
        key = api_key or os.getenv("CURSOR_ADMIN_API_KEY")
        if not key:
            raise ValueError("missing CURSOR_ADMIN_API_KEY")
        token = base64.b64encode(f"{key}:".encode("utf-8")).decode("ascii")
        self.headers = {
            "Authorization": f"Basic {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    def filtered_usage_events(
        self,
        *,
        days_back: int,
        page_size: int = 500,
    ) -> list[dict[str, Any]]:
        start_ms = int((datetime.now(timezone.utc) - timedelta(days=days_back)).timestamp() * 1000)
        events: list[dict[str, Any]] = []
        page = 1
        while True:
            body = {
                "page": page,
                "pageSize": page_size,
                "startDate": str(start_ms),
            }
            payload = _http_json(
                f"{self.BASE}/teams/filtered-usage-events",
                method="POST",
                headers=self.headers,
                body=body,
            )
            batch = payload.get("usageEventsDisplay") or payload.get("events") or []
            if not isinstance(batch, list):
                break
            events.extend(batch)
            total = int(payload.get("totalUsageEventsCount") or 0)
            if len(events) >= total or not batch:
                break
            page += 1
            if page > 200:
                break
        return events


def fetch_cursor_billing(days_back: int = 7) -> AgentBillingResult:
    display = "Cursor"
    try:
        client = CursorBillingClient()
    except ValueError as exc:
        return AgentBillingResult(
            agent="cursor",
            display_name=display,
            status="skipped",
            kind="unavailable",
            period_days=days_back,
            message=f"{exc} (Teams/Enterprise Admin API key from cursor.com/settings)",
            source="cursor_admin_api",
        )

    try:
        events = client.filtered_usage_events(days_back=days_back)
    except RuntimeError as exc:
        return AgentBillingResult(
            agent="cursor",
            display_name=display,
            status="error",
            kind="unavailable",
            period_days=days_back,
            message=str(exc),
            source="cursor_admin_api",
        )

    total_usd = 0.0
    by_model: dict[str, dict[str, float]] = {}
    for event in events:
        usage = event.get("tokenUsage") or event.get("usage") or {}
        cents_raw = usage.get("totalCents") or usage.get("total_cents") or event.get("requestCents") or 0
        try:
            cents = float(cents_raw)
        except (TypeError, ValueError):
            cents = 0.0
        event_usd = cents / 100.0
        total_usd += event_usd
        model = str(event.get("model") or "unknown")
        bucket = by_model.setdefault(model, {"cost_usd": 0.0, "tokens": 0})
        bucket["cost_usd"] += event_usd
        input_t = int(usage.get("inputTokens") or usage.get("input_tokens") or 0)
        output_t = int(usage.get("outputTokens") or usage.get("output_tokens") or 0)
        bucket["tokens"] += input_t + output_t

    models = [
        ModelCostLine(model=m, cost_usd=round(v["cost_usd"], 6), tokens=int(v["tokens"]))
        for m, v in sorted(by_model.items(), key=lambda kv: kv[1]["cost_usd"], reverse=True)
    ]
    total_usd = round(total_usd, 4)

    return AgentBillingResult(
        agent="cursor",
        display_name=display,
        status="ok",
        kind="invoice_usd",
        cost_usd=round(total_usd, 4),
        period_days=days_back,
        message=f"Cursor Admin API: {len(events)} usage events with billed cents.",
        models=models,
        source="cursor_admin_api",
        extra={"events": len(events)},
    )


class GitHubCopilotBillingClient:
    def __init__(self, token: str | None = None, org: str | None = None) -> None:
        self.token = token or os.getenv("GITHUB_TOKEN") or os.getenv("GH_TOKEN")
        self.org = org or os.getenv("GITHUB_ORG") or os.getenv("GITHUB_COPILOT_ORG")
        if not self.token:
            raise ValueError("missing GITHUB_TOKEN")
        if not self.org:
            raise ValueError("missing GITHUB_ORG")
        self.headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    def billing(self) -> dict[str, Any]:
        return _http_json(
            f"https://api.github.com/orgs/{self.org}/copilot/billing",
            headers=self.headers,
        )

    def seats(self) -> dict[str, Any]:
        return _http_json(
            f"https://api.github.com/orgs/{self.org}/copilot/billing/seats",
            headers={**self.headers},
            params={"per_page": 100, "page": 1},
        )


def fetch_copilot_billing(days_back: int = 7) -> AgentBillingResult:
    display = "GitHub Copilot"
    try:
        client = GitHubCopilotBillingClient()
    except ValueError as exc:
        return AgentBillingResult(
            agent="copilot",
            display_name=display,
            status="skipped",
            kind="unavailable",
            period_days=days_back,
            message=str(exc),
            source="github_copilot_billing_api",
        )

    try:
        billing = client.billing()
        seats_payload = client.seats()
    except RuntimeError as exc:
        return AgentBillingResult(
            agent="copilot",
            display_name=display,
            status="error",
            kind="unavailable",
            period_days=days_back,
            message=str(exc),
            source="github_copilot_billing_api",
        )

    breakdown = billing.get("seat_breakdown") or {}
    total_seats = int(breakdown.get("total") or seats_payload.get("total_seats") or 0)
    seat_price = float(os.getenv("COPILOT_SEAT_PRICE_USD", "19"))
    cycle_cost = round(total_seats * seat_price, 2)

    return AgentBillingResult(
        agent="copilot",
        display_name=display,
        status="ok",
        kind="subscription_seats",
        cost_usd=cycle_cost,
        period_days=days_back,
        message=(
            f"GitHub Copilot Business/Enterprise: {total_seats} billed seats "
            f"(~${seat_price}/seat/month via COPILOT_SEAT_PRICE_USD). "
            "No per-token invoice API — seat subscription billing."
        ),
        models=[],
        source="github_copilot_billing_api",
        extra={
            "org": client.org,
            "plan_type": billing.get("plan_type"),
            "seat_breakdown": breakdown,
            "seat_price_usd": seat_price,
        },
    )


def fetch_kiro_billing(days_back: int = 7) -> AgentBillingResult:
    return AgentBillingResult(
        agent="kiro",
        display_name="Kiro",
        status="skipped",
        kind="unavailable",
        period_days=days_back,
        message="No public Kiro billing/usage API. Use vendor console for invoices.",
        source="none",
    )


AGENT_FETCHERS = {
    "claude": fetch_claude_billing,
    "cursor": fetch_cursor_billing,
    "copilot": fetch_copilot_billing,
    "kiro": fetch_kiro_billing,
}


def fetch_all_agent_billing(
    days_back: int = 7,
    agents: list[AgentId] | None = None,
) -> list[AgentBillingResult]:
    selected = agents or list(AGENT_FETCHERS.keys())
    return [AGENT_FETCHERS[agent](days_back) for agent in selected if agent in AGENT_FETCHERS]
