#!/usr/bin/env python3
"""Read-only New API dashboard backend.

The browser never receives the upstream API key. Configuration is loaded from
the process environment first and from ~/.newapi_env / ~/.bashrc as a fallback.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


HOST = "127.0.0.1"
PORT = 18765
CACHE_FILE = Path(os.environ.get("IPRCAPI_CACHE_FILE", "/var/lib/iprcapi-dashboard/source-cache.json"))
SOURCE_CACHE_SECONDS = {
    "usage": 300,
    "logs": 300,
    "models": 21_600,
    "pricing": 21_600,
    "status": 21_600,
}
CRITICAL_SOURCES = ("usage", "logs")
CRITICAL_WINDOW_SECONDS = 1_200
# The upstream allows 20 Critical requests per 20 minutes. Keeping four slots
# unused protects the dashboard from timing jitter and other legitimate users.
CRITICAL_REQUEST_LIMIT = 16
CRITICAL_MIN_GAP_SECONDS = 70
UPDATE_TICK_SECONDS = 5
SOURCES = {
    "usage": ("/api/usage/token/", "host"),
    "logs": ("/api/log/token", "host"),
    "models": ("/models", "v1"),
    "pricing": ("/api/pricing", "host"),
    "status": ("/api/status", "host"),
}
ENV_NAMES = {
    "NEW_API_KEY",
    "NEW_API_HOST",
    "NEW_API_BASE_URL",
}


def load_shell_env() -> dict[str, str]:
    """Read simple shell assignments without executing the shell file."""
    values = {name: os.environ[name] for name in ENV_NAMES if os.environ.get(name)}
    for path in (Path.home() / ".newapi_env", Path.home() / ".bashrc"):
        if not path.is_file():
            continue
        for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            match = re.match(
                r"^\s*(?:export\s+)?(" + "|".join(sorted(ENV_NAMES)) + r")=(.*)$",
                raw_line,
            )
            if not match or match.group(1) in values:
                continue
            try:
                parsed = shlex.split(match.group(2), posix=True)
            except ValueError:
                continue
            if len(parsed) == 1:
                values[match.group(1)] = parsed[0]
    return values


CONFIG = load_shell_env()
API_KEY = CONFIG.get("NEW_API_KEY", "")
API_HOST = CONFIG.get("NEW_API_HOST", "").rstrip("/")
API_BASE_URL = CONFIG.get("NEW_API_BASE_URL", f"{API_HOST}/v1").rstrip("/")


class UpstreamError(RuntimeError):
    def __init__(
        self,
        message: str,
        status: int | None = None,
        retry_after: int | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


def upstream_json(path: str, *, base: str = "host") -> Any:
    root = API_BASE_URL if base == "v1" else API_HOST
    request = urllib.request.Request(
        root + path,
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Accept": "application/json",
            "User-Agent": "iprcapi-dashboard/1.0",
        },
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    started = time.monotonic()
    try:
        with opener.open(request, timeout=7) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as exc:
        retry_after = None
        try:
            retry_after = max(1, int(exc.headers.get("Retry-After", "0")))
        except (TypeError, ValueError):
            pass
        raise UpstreamError(
            f"上游接口返回 HTTP {exc.code}",
            status=exc.code,
            retry_after=retry_after,
        ) from exc
    except urllib.error.URLError as exc:
        raise UpstreamError("无法连接到上游服务") from exc
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise UpstreamError("上游返回了无法解析的数据") from exc
    return payload, round((time.monotonic() - started) * 1000)


def upstream_json_with_retry(path: str, *, base: str = "host") -> Any:
    last_error: UpstreamError | None = None
    for attempt in range(2):
        try:
            return upstream_json(path, base=base)
        except UpstreamError as exc:
            last_error = exc
            if exc.status == HTTPStatus.TOO_MANY_REQUESTS:
                break
            if attempt == 0:
                time.sleep(0.2)
    raise last_error or UpstreamError("上游查询失败")


def unwrap(payload: Any, source: str) -> Any:
    if not isinstance(payload, dict):
        raise UpstreamError(f"{source} 返回格式异常")
    if payload.get("success") is False or payload.get("code") is False:
        raise UpstreamError(f"{source} 查询失败")
    return payload.get("data", payload)


def safe_number(value: Any) -> float:
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return value
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0


def sanitize_log(item: Any) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    allowed = (
        "id",
        "type",
        "created_at",
        "model_name",
        "quota",
        "prompt_tokens",
        "completion_tokens",
        "use_time",
        "is_streamed",
        "is_stream",
    )
    result = {key: item.get(key) for key in allowed if key in item}
    if "is_streamed" not in result and "is_stream" in result:
        result["is_streamed"] = result.pop("is_stream")
    return result


def extract_logs(payload: Any) -> list[dict[str, Any]]:
    """Normalize every response shape used by /api/log/token."""
    rows = unwrap(payload, "日志")
    if isinstance(rows, dict):
        rows = rows.get("items", [])
    if not isinstance(rows, list):
        raise UpstreamError("日志返回格式异常")
    return [entry for item in rows if (entry := sanitize_log(item))]


def summarize_logs(logs: list[dict[str, Any]]) -> dict[str, Any]:
    model_stats: dict[str, dict[str, float]] = defaultdict(
        lambda: {"requests": 0, "tokens": 0, "quota": 0}
    )
    daily_stats: dict[str, dict[str, float]] = defaultdict(
        lambda: {"requests": 0, "tokens": 0, "quota": 0}
    )
    daily_model_stats: dict[str, dict[str, dict[str, float]]] = defaultdict(
        lambda: defaultdict(lambda: {"requests": 0, "tokens": 0, "quota": 0})
    )
    totals = {
        "requests": len(logs),
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "tokens": 0,
        "quota": 0,
        "streamed_requests": 0,
    }
    now = int(time.time())
    for item in logs:
        prompt = safe_number(item.get("prompt_tokens"))
        completion = safe_number(item.get("completion_tokens"))
        quota = safe_number(item.get("quota"))
        token_count = prompt + completion
        totals["prompt_tokens"] += prompt
        totals["completion_tokens"] += completion
        totals["tokens"] += token_count
        totals["quota"] += quota
        if item.get("is_streamed"):
            totals["streamed_requests"] += 1
        model = str(item.get("model_name") or "未知模型")
        model_stats[model]["requests"] += 1
        model_stats[model]["tokens"] += token_count
        model_stats[model]["quota"] += quota
        timestamp = int(safe_number(item.get("created_at")))
        if timestamp > 0:
            day = time.strftime("%Y-%m-%d", time.localtime(timestamp))
            daily_stats[day]["requests"] += 1
            daily_stats[day]["tokens"] += token_count
            daily_stats[day]["quota"] += quota
            daily_model_stats[day][model]["requests"] += 1
            daily_model_stats[day][model]["tokens"] += token_count
            daily_model_stats[day][model]["quota"] += quota

    days = []
    for offset in range(13, -1, -1):
        day = time.strftime("%Y-%m-%d", time.localtime(now - offset * 86_400))
        day_models = [
            {"model": name, **stats}
            for name, stats in daily_model_stats.get(day, {}).items()
        ]
        days.append({
            "date": day,
            **daily_stats.get(day, {"requests": 0, "tokens": 0, "quota": 0}),
            "models": day_models,
        })
    models = [
        {"model": name, **stats}
        for name, stats in sorted(
            model_stats.items(), key=lambda pair: pair[1]["quota"], reverse=True
        )
    ]
    return {"totals": totals, "daily": days, "models": models}


def sanitize_status(status: Any) -> dict[str, Any]:
    if not isinstance(status, dict):
        return {}
    keys = (
        "system_name",
        "version",
        "start_time",
        "quota_per_unit",
        "quota_display_type",
        "display_in_currency",
        "usd_exchange_rate",
        "docs_link",
    )
    return {key: status.get(key) for key in keys if key in status}


def sanitize_pricing(rows: Any, available_ids: set[str]) -> list[dict[str, Any]]:
    if not isinstance(rows, list):
        return []
    keys = (
        "model_name",
        "quota_type",
        "model_ratio",
        "model_price",
        "completion_ratio",
        "cache_ratio",
        "create_cache_ratio",
        "enable_groups",
        "supported_endpoint_types",
        "vendor_id",
    )
    result = []
    for row in rows:
        if not isinstance(row, dict) or row.get("model_name") not in available_ids:
            continue
        result.append({key: row.get(key) for key in keys if key in row})
    return result


_cache_lock = threading.RLock()
_source_cache: dict[str, Any] = {}
_source_cache_at: dict[str, float] = {}
_source_attempt_at: dict[str, float] = {}
_source_errors: dict[str, str] = {}
_source_latencies: dict[str, int] = {}
_critical_request_times: list[float] = []
_critical_backoff_until = 0.0


def load_persistent_source_cache() -> None:
    global _critical_backoff_until, _critical_request_times
    try:
        saved = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
        saved_at = float(saved.get("saved_at", 0))
        saved_source_times = saved.get("source_cache_at", {})
        saved_attempt_times = saved.get("source_attempt_at", {})
        sources = saved.get("sources", {})
        if not isinstance(sources, dict) or saved_at <= 0:
            return
        for name in SOURCES:
            if name in sources:
                value = sources[name]
                if name == "logs":
                    # Migrate old raw payloads and keep only the public
                    # allow-list in the persistent server cache.
                    value = extract_logs(value) if not isinstance(value, list) else [
                        entry for item in value if (entry := sanitize_log(item))
                    ]
                _source_cache[name] = value
                _source_cache_at[name] = float(saved_source_times.get(name, saved_at))
                _source_attempt_at[name] = float(
                    saved_attempt_times.get(name, _source_cache_at[name])
                )
        saved_backoff = max(0, float(saved.get("critical_backoff_until", 0)))
        _critical_backoff_until = saved_backoff
        cutoff = time.time() - CRITICAL_WINDOW_SECONDS
        saved_requests = saved.get("critical_request_times", [])
        if isinstance(saved_requests, list):
            _critical_request_times = [
                float(value) for value in saved_requests
                if isinstance(value, (int, float)) and float(value) > cutoff
            ]
        if not _critical_request_times:
            # Older cache files did not record attempts. The latest successful
            # Critical update is a safe lower bound after a restart.
            legacy_last = max(
                (_source_cache_at.get(name, 0) for name in CRITICAL_SOURCES),
                default=0,
            )
            if legacy_last > cutoff:
                _critical_request_times = [legacy_last]
    except (OSError, ValueError, TypeError, json.JSONDecodeError, UpstreamError):
        return


def save_persistent_source_cache() -> None:
    sources = {
        name: _source_cache[name]
        for name in SOURCES
        if name in _source_cache
    }
    try:
        CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        temporary = CACHE_FILE.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(
                {
                    "saved_at": time.time(),
                    "source_cache_at": {
                        name: _source_cache_at.get(name, 0)
                        for name in sources
                    },
                    "source_attempt_at": {
                        name: _source_attempt_at.get(name, 0)
                        for name in SOURCES
                    },
                    "critical_request_times": _critical_request_times,
                    "critical_backoff_until": _critical_backoff_until,
                    "sources": sources,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        temporary.chmod(0o600)
        temporary.replace(CACHE_FILE)
    except OSError:
        return


load_persistent_source_cache()


def prune_critical_requests(now: float) -> None:
    cutoff = now - CRITICAL_WINDOW_SECONDS
    _critical_request_times[:] = [value for value in _critical_request_times if value > cutoff]


def critical_request_allowed(now: float) -> bool:
    prune_critical_requests(now)
    if now < _critical_backoff_until:
        return False
    if _critical_request_times and now - _critical_request_times[-1] < CRITICAL_MIN_GAP_SECONDS:
        return False
    return len(_critical_request_times) < CRITICAL_REQUEST_LIMIT


def source_is_due(name: str, now: float) -> bool:
    last_check = max(_source_cache_at.get(name, 0), _source_attempt_at.get(name, 0))
    return now - last_check >= SOURCE_CACHE_SECONDS[name]


def refresh_source(name: str) -> bool:
    """Fetch one source for the background worker; never called by HTTP handlers."""
    global _critical_backoff_until
    now = time.time()
    with _cache_lock:
        if not source_is_due(name, now):
            return False
        if name in CRITICAL_SOURCES and not critical_request_allowed(now):
            return False
        _source_attempt_at[name] = now
        if name in CRITICAL_SOURCES:
            # Persist attempts before I/O so a process restart cannot reset the
            # rolling request budget after a timeout or an HTTP error.
            _critical_request_times.append(now)
        save_persistent_source_cache()

    path, base = SOURCES[name]
    try:
        if name in CRITICAL_SOURCES:
            payload, latency = upstream_json(path, base=base)
        else:
            payload, latency = upstream_json_with_retry(path, base=base)
        value = extract_logs(payload) if name == "logs" else payload
        with _cache_lock:
            _source_cache[name] = value
            _source_cache_at[name] = time.time()
            _source_latencies[name] = latency
            _source_errors.pop(name, None)
            save_persistent_source_cache()
        print(f"background update succeeded: {name} ({latency} ms)", flush=True)
    except UpstreamError as exc:
        with _cache_lock:
            _source_errors[name] = str(exc)
            if name in CRITICAL_SOURCES and exc.status == HTTPStatus.TOO_MANY_REQUESTS:
                retry_after = exc.retry_after or SOURCE_CACHE_SECONDS[name]
                _critical_backoff_until = max(_critical_backoff_until, time.time() + retry_after)
            save_persistent_source_cache()
        print(f"background update failed: {name}: {exc}", flush=True)
    except Exception:
        with _cache_lock:
            _source_errors[name] = "查询时发生临时错误"
            save_persistent_source_cache()
        print(f"background update failed: {name}: unexpected error", flush=True)
    return True


def refresh_due_sources() -> None:
    now = time.time()
    # Update at most one Critical source per tick. Missing/oldest data wins, so
    # quota and logs remain fair while sharing one rolling request budget.
    critical_due = sorted(
        (name for name in CRITICAL_SOURCES if source_is_due(name, now)),
        key=lambda name: _source_cache_at.get(name, 0),
    )
    for name in critical_due:
        if refresh_source(name):
            break
    for name in ("models", "pricing", "status"):
        refresh_source(name)


def update_worker(stop_event: threading.Event) -> None:
    while not stop_event.is_set():
        refresh_due_sources()
        stop_event.wait(UPDATE_TICK_SECONDS)


def build_dashboard() -> dict[str, Any]:
    """Build a public response exclusively from the server's local cache."""
    with _cache_lock:
        fetched = dict(_source_cache)
        source_times = dict(_source_cache_at)
        errors = dict(_source_errors)
        latencies = dict(_source_latencies)
        backoff_until = _critical_backoff_until

    usage = unwrap(fetched["usage"], "额度") if "usage" in fetched else {}
    model_payload = fetched.get("models", {})
    raw_models = model_payload.get("data", []) if isinstance(model_payload, dict) else []
    models = [
        {
            "id": row.get("id"),
            "owned_by": row.get("owned_by") or "unknown",
            "created": row.get("created"),
        }
        for row in raw_models
        if isinstance(row, dict) and row.get("id")
    ]
    available_ids = {row["id"] for row in models}
    logs = fetched.get("logs", [])
    if not isinstance(logs, list):
        logs = extract_logs(logs)
    logs = [entry for item in logs if (entry := sanitize_log(item))]
    pricing_payload = fetched.get("pricing", {})
    pricing_rows = unwrap(pricing_payload, "计费") if pricing_payload else []
    status_payload = unwrap(fetched["status"], "状态") if "status" in fetched else {}

    vendor_lookup: dict[int, str] = {}
    endpoints: dict[str, Any] = {}
    groups: dict[str, Any] = {}
    if isinstance(pricing_payload, dict):
        vendor_lookup = {
            int(vendor["id"]): str(vendor.get("name") or vendor["id"])
            for vendor in pricing_payload.get("vendors", [])
            if isinstance(vendor, dict) and isinstance(vendor.get("id"), int)
        }
        endpoints = pricing_payload.get("supported_endpoint") or {}
        groups = pricing_payload.get("usable_group") or {}

    stale_sources = [name for name in errors if name in fetched]
    visible_errors = {name: message for name, message in errors.items() if name not in fetched}
    updated_at = {name: int(source_times.get(name, 0)) for name in SOURCES}
    data_updated_at = max(source_times.values(), default=0)
    return {
        "generated_at": int(time.time()),
        "data_updated_at": int(data_updated_at),
        "cached": True,
        "usage": usage if isinstance(usage, dict) else {},
        "models": models,
        "pricing": sanitize_pricing(pricing_rows, available_ids),
        "vendors": vendor_lookup,
        "endpoints": endpoints,
        "groups": groups,
        "status": sanitize_status(status_payload),
        "logs": logs[:1000],
        "analytics": summarize_logs(logs),
        "health": {
            "ok": not visible_errors,
            "stale": bool(stale_sources),
            "stale_sources": stale_sources,
            "latencies_ms": latencies,
            "errors": visible_errors,
        },
        "refresh": {
            "updated_at": updated_at,
            "critical_backoff_until": int(backoff_until),
        },
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "IPRCAPI/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"{self.address_string()} - {fmt % args}", flush=True)

    def json_response(
        self,
        status: int,
        payload: Any,
    ) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = urllib.parse.urlsplit(self.path).path.rstrip("/")
        if path == "/iprcapi/api/dashboard":
            try:
                self.json_response(200, build_dashboard())
            except UpstreamError as exc:
                self.json_response(HTTPStatus.BAD_GATEWAY, {"error": str(exc)})
            except Exception:
                self.json_response(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "看板暂时不可用"})
            return
        self.json_response(HTTPStatus.NOT_FOUND, {"error": "Not found"})

def main() -> None:
    missing = [name for name in ("NEW_API_KEY", "NEW_API_HOST") if not CONFIG.get(name)]
    if missing:
        raise SystemExit("Missing required environment variables: " + ", ".join(missing))
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    stop_event = threading.Event()
    updater = threading.Thread(
        target=update_worker,
        args=(stop_event,),
        name="cache-updater",
        daemon=True,
    )
    updater.start()
    print(f"IPRC API dashboard listening on http://{HOST}:{PORT}", flush=True)
    try:
        server.serve_forever()
    finally:
        stop_event.set()
        updater.join(timeout=2)
        server.server_close()


if __name__ == "__main__":
    main()
