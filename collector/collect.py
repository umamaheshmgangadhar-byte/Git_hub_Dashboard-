#!/usr/bin/env python3
"""
GitHub account or organization-wide GitHub Actions metrics collector.

Authentication:
    - Uses the ACTIONS_DASHBOARD_TOKEN personal access token for GitHub REST API calls.

Output:
  data/dashboard.json
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlparse

import requests


API_VERSION = "2026-03-10"
DEFAULT_API_URL = "https://api.github.com"
OUTPUT_PATH = Path(__file__).resolve().parents[1] / "data" / "dashboard.json"
REQUEST_TIMEOUT = 30
MAX_RETRIES = 5
PAGE_SIZE = 100

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
LOG = logging.getLogger("github-actions-dashboard")


class GitHubAPIError(RuntimeError):
    """Raised when a GitHub API request cannot be completed."""


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def parse_github_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def iso_z(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def safe_login(obj: dict[str, Any] | None) -> str:
    return str((obj or {}).get("login") or "unknown")


def duration_seconds(run: dict[str, Any], now: datetime) -> float | None:
    started = parse_github_datetime(run.get("run_started_at"))
    if not started:
        started = parse_github_datetime(run.get("created_at"))
    if not started:
        return None

    if run.get("status") in {"queued", "requested", "waiting", "pending", "in_progress"}:
        ended = now
    else:
        ended = parse_github_datetime(run.get("updated_at")) or now

    seconds = max(0.0, (ended - started).total_seconds())
    return round(seconds, 3)


def display_duration(seconds: float | None) -> str:
    if seconds is None:
        return "—"
    seconds = int(round(seconds))
    if seconds < 60:
        return f"{seconds}s"
    minutes, secs = divmod(seconds, 60)
    if minutes < 60:
        return f"{minutes}m {secs}s"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h {minutes}m"


class GitHubClient:
    def __init__(self, token: str, api_url: str = DEFAULT_API_URL):
        self.api_url = api_url.rstrip("/")
        self.session = requests.Session()
        self.session.headers.update(
            {
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {token}",
                "X-GitHub-Api-Version": API_VERSION,
                "User-Agent": "github-actions-organization-dashboard",
            }
        )

    def request(
        self,
        method: str,
        path_or_url: str,
        *,
        params: dict[str, Any] | None = None,
        expected: Iterable[int] = (200,),
    ) -> requests.Response:
        url = path_or_url if path_or_url.startswith("http") else f"{self.api_url}{path_or_url}"

        last_error: Exception | None = None
        for attempt in range(MAX_RETRIES):
            try:
                response = self.session.request(
                    method,
                    url,
                    params=params,
                    timeout=REQUEST_TIMEOUT,
                )
            except requests.RequestException as exc:
                last_error = exc
                sleep_for = min(2 ** attempt, 16)
                LOG.warning("Network error calling %s: %s; retrying in %ss", url, exc, sleep_for)
                time.sleep(sleep_for)
                continue

            if response.status_code in expected:
                return response

            if response.status_code in {429, 500, 502, 503, 504}:
                retry_after = response.headers.get("Retry-After")
                try:
                    sleep_for = min(float(retry_after), 60) if retry_after else min(2 ** attempt, 16)
                except ValueError:
                    sleep_for = min(2 ** attempt, 16)
                LOG.warning(
                    "GitHub API %s for %s; retrying in %ss",
                    response.status_code,
                    url,
                    sleep_for,
                )
                time.sleep(sleep_for)
                continue

            try:
                body = response.json()
            except ValueError:
                body = response.text[:500]
            raise GitHubAPIError(
                f"{method} {url} failed with HTTP {response.status_code}: {body}"
            )

        raise GitHubAPIError(f"{method} {url} failed after retries: {last_error or 'unknown error'}")

    def get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        return self.request("GET", path, params=params).json()

    def paginate(self, path: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        params = dict(params or {})
        params.setdefault("per_page", PAGE_SIZE)

        first_url = path
        items: list[dict[str, Any]] = []
        while first_url:
            response = self.request("GET", first_url, params=params)
            payload = response.json()
            if isinstance(payload, dict):
                values = (
                    payload.get("repositories")
                    or payload.get("workflows")
                    or payload.get("workflow_runs")
                    or payload.get("deployments")
                    or payload.get("runners")
                    or []
                )
            elif isinstance(payload, list):
                values = payload
            else:
                values = []

            if isinstance(values, list):
                items.extend(values)

            first_url = None
            next_url = response.links.get("next", {}).get("url")
            if next_url:
                first_url = next_url
                params = {}
        return items


def classify_run(run: dict[str, Any]) -> str:
    status = str(run.get("status") or "").lower()
    conclusion = str(run.get("conclusion") or "").lower()

    if status in {"queued", "requested", "waiting", "pending", "in_progress"}:
        return "running"
    if conclusion == "success":
        return "success"
    if conclusion in {"failure", "timed_out", "action_required"}:
        return "failed"
    return "other"


def run_record(
    repo: dict[str, Any],
    run: dict[str, Any],
    workflow_names: dict[int, str],
    now: datetime,
) -> dict[str, Any]:
    workflow_id = run.get("workflow_id")
    workflow_name = (
        str(run.get("name") or "")
        or workflow_names.get(workflow_id)
        or f"Workflow {workflow_id}"
    )
    seconds = duration_seconds(run, now)
    category = classify_run(run)

    return {
        "run_id": run.get("id"),
        "repository": repo.get("name"),
        "full_repository_name": repo.get("full_name"),
        "workflow_id": workflow_id,
        "workflow_name": workflow_name,
        "branch": run.get("head_branch") or "(detached)",
        "event": run.get("event") or "unknown",
        "status": run.get("status") or "unknown",
        "conclusion": run.get("conclusion"),
        "category": category,
        "created_at": run.get("created_at"),
        "updated_at": run.get("updated_at"),
        "duration_seconds": seconds,
        "duration": display_duration(seconds),
        "actor": safe_login(run.get("actor")),
        "run_url": run.get("html_url"),
    }


def percentage(numerator: int, denominator: int) -> float:
    return round((numerator / denominator) * 100, 2) if denominator else 0.0


def aggregate_metrics(runs: list[dict[str, Any]]) -> dict[str, Any]:
    success = sum(run["category"] == "success" for run in runs)
    failed = sum(run["category"] == "failed" for run in runs)
    running = sum(run["category"] == "running" for run in runs)
    completed_relevant = success + failed

    durations = [
        float(run["duration_seconds"])
        for run in runs
        if run.get("duration_seconds") is not None
        and run["category"] in {"success", "failed", "other"}
    ]

    return {
        "total_runs": len(runs),
        "successful_runs": success,
        "failed_runs": failed,
        "running_runs": running,
        "other_runs": len(runs) - success - failed - running,
        "success_percentage": percentage(success, completed_relevant),
        "failure_percentage": percentage(failed, completed_relevant),
        "average_duration_seconds": round(sum(durations) / len(durations), 3) if durations else 0,
        "fastest_run_seconds": min(durations) if durations else 0,
        "slowest_run_seconds": max(durations) if durations else 0,
    }


def collect_deployments(
    client: GitHubClient,
    repositories: list[dict[str, Any]],
    cutoff: datetime,
) -> list[dict[str, Any]]:
    deployments: list[dict[str, Any]] = []
    for repo in repositories:
        owner = repo["owner"]["login"]
        name = repo["name"]
        try:
            raw = client.paginate(f"/repos/{owner}/{name}/deployments", {"per_page": 100})
        except GitHubAPIError as exc:
            # Deployments are a secondary dashboard surface. Keep Actions metrics usable
            # if a repository's deployment permission is unavailable.
            LOG.warning("Could not collect deployments for %s: %s", repo["full_name"], exc)
            continue

        for deployment in raw:
            created = parse_github_datetime(deployment.get("created_at"))
            if created and created < cutoff:
                continue
            deployments.append(
                {
                    "id": deployment.get("id"),
                    "repository": repo["name"],
                    "full_repository_name": repo["full_name"],
                    "environment": deployment.get("environment"),
                    "ref": deployment.get("ref"),
                    "task": deployment.get("task"),
                    "creator": safe_login(deployment.get("creator")),
                    "created_at": deployment.get("created_at"),
                    "updated_at": deployment.get("updated_at"),
                    "deployment_url": f"https://github.com/{repo['full_name']}/deployments/activity_log",
                }
            )
    deployments.sort(key=lambda item: item.get("created_at") or "", reverse=True)
    return deployments[:200]


def build_dashboard(
    organization: str,
    repositories: list[dict[str, Any]],
    all_workflows: list[dict[str, Any]],
    all_runs: list[dict[str, Any]],
    deployments: list[dict[str, Any]],
    now: datetime,
    cutoff: datetime,
) -> dict[str, Any]:
    org_metrics = aggregate_metrics(all_runs)

    # Chart data is based on the requested seven-day collection window.
    daily: dict[str, Counter[str]] = defaultdict(Counter)
    for run in all_runs:
        created = parse_github_datetime(run.get("created_at"))
        if not created:
            continue
        day = created.astimezone(timezone.utc).date().isoformat()
        daily[day][run["category"]] += 1

    dates = [
        (cutoff + timedelta(days=index)).date().isoformat()
        for index in range((now.date() - cutoff.date()).days + 1)
    ]
    chart = {
        "labels": dates,
        "successful": [daily[day]["success"] for day in dates],
        "failed": [daily[day]["failed"] for day in dates],
        "running": [daily[day]["running"] for day in dates],
    }

    runs_by_repo: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for run in all_runs:
        runs_by_repo[run["full_repository_name"]].append(run)

    workflows_by_repo: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for workflow in all_workflows:
        workflows_by_repo[workflow["full_repository_name"]].append(workflow)

    repository_rows: list[dict[str, Any]] = []
    for repo in repositories:
        full_name = repo["full_name"]
        repo_runs = runs_by_repo.get(full_name, [])
        repo_metrics = aggregate_metrics(repo_runs)
        repo_runs_sorted = sorted(
            repo_runs,
            key=lambda item: item.get("created_at") or "",
            reverse=True,
        )
        latest = repo_runs_sorted[0] if repo_runs_sorted else None

        repository_rows.append(
            {
                "name": repo["name"],
                "full_repository_name": full_name,
                "url": repo["html_url"],
                "visibility": "private" if repo.get("private") else "public",
                "workflows": len(workflows_by_repo.get(full_name, [])),
                "runs": repo_metrics["total_runs"],
                "successful_runs": repo_metrics["successful_runs"],
                "failed_runs": repo_metrics["failed_runs"],
                "running_runs": repo_metrics["running_runs"],
                "success_percentage": repo_metrics["success_percentage"],
                "average_duration_seconds": repo_metrics["average_duration_seconds"],
                "latest_status": (
                    latest["category"] if latest else "other"
                ),
                "latest_run": latest,
            }
        )

    repository_rows.sort(key=lambda item: item["name"].lower())

    workflow_rows = [
        {
            "id": workflow.get("id"),
            "name": workflow.get("name"),
            "path": workflow.get("path"),
            "state": workflow.get("state"),
            "repository": workflow["repository"],
            "full_repository_name": workflow["full_repository_name"],
            "url": workflow.get("html_url"),
        }
        for workflow in all_workflows
    ]
    workflow_rows.sort(key=lambda item: (item["full_repository_name"].lower(), item["name"].lower()))

    runs_sorted = sorted(
        all_runs,
        key=lambda item: item.get("created_at") or "",
        reverse=True,
    )

    failures = [run for run in runs_sorted if run["category"] == "failed"][:100]

    return {
        "schema_version": 1,
        "generated_at": iso_z(now),
        "window": {
            "name": "Last 7 Days",
            "start": iso_z(cutoff),
            "end": iso_z(now),
        },
        "organization": organization,
        "metrics": {
            "total_repositories": len(repositories),
            "total_workflows": len(all_workflows),
            **org_metrics,
        },
        "performance": {
            "average_duration_seconds": org_metrics["average_duration_seconds"],
            "fastest_run_seconds": org_metrics["fastest_run_seconds"],
            "slowest_run_seconds": org_metrics["slowest_run_seconds"],
            "failure_rate": org_metrics["failure_percentage"],
        },
        "chart": chart,
        "repositories": repository_rows,
        "workflows": workflow_rows,
        "workflow_runs": runs_sorted[:1000],
        "failures": failures,
        "deployments": deployments,
        "capabilities": {
            "runners": {
                "available": False,
                "reason": (
                    "Runner inventory requires the 'Self-hosted runners: Read' "
                    "permission. This project intentionally does not request "
                    "that additional permission."
                ),
            }
        },
    }


def main() -> int:
    organization = os.environ.get("ACTIONS_DASHBOARD_ORGANIZATION", "").strip()
    token = os.environ.get("ACTIONS_DASHBOARD_TOKEN", "").strip()
    if not organization:
        raise ValueError("ACTIONS_DASHBOARD_ORGANIZATION is required.")
    if not token:
        raise ValueError("ACTIONS_DASHBOARD_TOKEN is required.")

    LOG.info("Starting organization collection for %s", organization)

    client = GitHubClient(token)

    repositories_raw = client.paginate(f"/users/{organization}/repos", {"type": "all"})
    repositories = [
        repo
        for repo in repositories_raw
        if not repo.get("archived", False)
        and str((repo.get("owner") or {}).get("login", "")).lower() == organization.lower()
    ]
    repositories.sort(key=lambda repo: repo["full_name"].lower())
    LOG.info("Discovered %s non-archived organization repositories", len(repositories))

    now = utc_now()
    cutoff = now - timedelta(days=7)
    created_filter = f">={iso_z(cutoff)}"

    all_workflows: list[dict[str, Any]] = []
    all_runs: list[dict[str, Any]] = []

    for index, repo in enumerate(repositories, start=1):
        owner = repo["owner"]["login"]
        name = repo["name"]
        full_name = repo["full_name"]
        LOG.info("[%s/%s] Collecting %s", index, len(repositories), full_name)

        try:
            workflows_raw = client.paginate(
                f"/repos/{owner}/{name}/actions/workflows",
                {"per_page": 100},
            )
        except GitHubAPIError as exc:
            LOG.error("Workflows unavailable for %s: %s", full_name, exc)
            continue

        workflow_names: dict[int, str] = {}
        for workflow in workflows_raw:
            workflow_id = workflow.get("id")
            if workflow_id is not None:
                workflow_names[int(workflow_id)] = str(workflow.get("name") or workflow_id)

            all_workflows.append(
                {
                    "id": workflow.get("id"),
                    "name": workflow.get("name"),
                    "path": workflow.get("path"),
                    "state": workflow.get("state"),
                    "repository": name,
                    "full_repository_name": full_name,
                    "html_url": workflow.get("html_url"),
                }
            )

        try:
            runs_raw = client.paginate(
                f"/repos/{owner}/{name}/actions/runs",
                {
                    "created": created_filter,
                    "per_page": 100,
                },
            )
        except GitHubAPIError as exc:
            LOG.error("Workflow runs unavailable for %s: %s", full_name, exc)
            continue

        for run in runs_raw:
            record = run_record(repo, run, workflow_names, now)
            all_runs.append(record)

    deployments = collect_deployments(client, repositories, cutoff)

    dashboard = build_dashboard(
        organization=organization,
        repositories=repositories,
        all_workflows=all_workflows,
        all_runs=all_runs,
        deployments=deployments,
        now=now,
        cutoff=cutoff,
    )

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = OUTPUT_PATH.with_suffix(".json.tmp")
    temporary_path.write_text(
        json.dumps(dashboard, indent=2, sort_keys=False) + "\n",
        encoding="utf-8",
    )
    temporary_path.replace(OUTPUT_PATH)

    LOG.info(
        "Wrote %s: %s repositories, %s workflows, %s runs",
        OUTPUT_PATH,
        dashboard["metrics"]["total_repositories"],
        dashboard["metrics"]["total_workflows"],
        dashboard["metrics"]["total_runs"],
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        LOG.exception("Collector failed: %s", exc)
        sys.exit(1)
