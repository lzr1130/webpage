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
from concurrent.futures import ThreadPoolExecutor, as_completed
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


HOST = "127.0.0.1"
PORT = 18765
CACHE_SECONDS = 5
CACHE_FILE = Path(os.environ.get("IPRCAPI_CACHE_FILE", "/var/lib/iprcapi-dashboard/source-cache.json"))
SOURCE_CACHE_SECONDS = {
    "usage": 5,
    "logs": 5,
    "models": 300,
    "pricing": 300,
    "status": 300,
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
    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


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
        raise UpstreamError(f"上游接口返回 HTTP {exc.code}", status=exc.code) from exc
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
    )
    return {key: item.get(key) for key in allowed if key in item}


def summarize_logs(logs: list[dict[str, Any]]) -> dict[str, Any]:
    model_stats: dict[str, dict[str, float]] = defaultdict(
        lambda: {"requests": 0, "tokens": 0, "quota": 0}
    )
    daily_stats: dict[str, dict[str, float]] = defaultdict(
        lambda: {"requests": 0, "tokens": 0, "quota": 0}
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

    days = []
    for offset in range(13, -1, -1):
        day = time.strftime("%Y-%m-%d", time.localtime(now - offset * 86_400))
        days.append({"date": day, **daily_stats.get(day, {"requests": 0, "tokens": 0, "quota": 0})})
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


_cache_lock = threading.Lock()
_cache: dict[str, Any] = {"at": 0, "value": None}
_source_cache: dict[str, Any] = {}
_source_cache_at: dict[str, float] = {}


def load_persistent_source_cache() -> None:
    try:
        saved = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
        saved_at = float(saved.get("saved_at", 0))
        sources = saved.get("sources", {})
        if not isinstance(sources, dict) or saved_at <= 0:
            return
        for name in ("usage", "models", "pricing", "status"):
            if name in sources:
                _source_cache[name] = sources[name]
                _source_cache_at[name] = saved_at
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return


def save_persistent_source_cache() -> None:
    sources = {
        name: _source_cache[name]
        for name in ("usage", "models", "pricing", "status")
        if name in _source_cache
    }
    if not sources:
        return
    try:
        CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        temporary = CACHE_FILE.with_suffix(".tmp")
        temporary.write_text(
            json.dumps({"saved_at": time.time(), "sources": sources}, ensure_ascii=False),
            encoding="utf-8",
        )
        temporary.chmod(0o600)
        temporary.replace(CACHE_FILE)
    except OSError:
        return


load_persistent_source_cache()


def build_dashboard(force: bool = False) -> dict[str, Any]:
    with _cache_lock:
        cache_age = time.time() - _cache["at"]
        # Even explicit refreshes reuse a very recent result so a public client
        # cannot turn this endpoint into an upstream request amplifier.
        if _cache["value"] and cache_age < CACHE_SECONDS:
            cached = dict(_cache["value"])
            cached["cached"] = True
            return cached

        errors: dict[str, str] = {}
        stale_sources: list[str] = []
        latencies: dict[str, int] = {}
        fetched: dict[str, Any] = dict(_source_cache)
        sources = {
            "usage": ("/api/usage/token/", "host"),
            "models": ("/models", "v1"),
            "logs": ("/api/log/token", "host"),
            "pricing": ("/api/pricing", "host"),
            "status": ("/api/status", "host"),
        }
        now = time.time()
        due_sources = {
            name: value
            for name, value in sources.items()
            if now - _source_cache_at.get(name, 0) >= SOURCE_CACHE_SECONDS[name]
        }
        # Independent endpoints are fetched with limited concurrency. Stable
        # metadata uses a longer TTL; only quota and logs refresh every 5s.
        updated_persistent_source = False
        with ThreadPoolExecutor(max_workers=min(3, max(1, len(due_sources)))) as executor:
            futures = {
                executor.submit(upstream_json_with_retry, path, base=base): name
                for name, (path, base) in due_sources.items()
            }
            for future in as_completed(futures):
                name = futures[future]
                try:
                    payload, latency = future.result()
                    fetched[name] = payload
                    _source_cache[name] = payload
                    _source_cache_at[name] = time.time()
                    if name != "logs":
                        updated_persistent_source = True
                    latencies[name] = latency
                except UpstreamError as exc:
                    errors[name] = str(exc)
                except Exception:
                    errors[name] = "查询时发生临时错误"
        for name in errors:
            if name in _source_cache:
                fetched[name] = _source_cache[name]
                stale_sources.append(name)
        for optional_source in ("logs", "status"):
            if optional_source in errors and optional_source not in stale_sources:
                stale_sources.append(optional_source)
        visible_errors = {
            name: message
            for name, message in errors.items()
            if name not in stale_sources
        }
        if updated_persistent_source:
            save_persistent_source_cache()

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
        log_payload = unwrap(fetched["logs"], "日志") if "logs" in fetched else []
        if isinstance(log_payload, dict):
            log_payload = log_payload.get("items", [])
        logs = [entry for item in (log_payload or []) if (entry := sanitize_log(item))]
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

        response = {
            "generated_at": int(time.time()),
            "cached": False,
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
        }
        _cache.update(at=time.time(), value=response)
        return response


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
            force = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get("refresh") == ["1"]
            try:
                self.json_response(200, build_dashboard(force=force))
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
    print(f"IPRC API dashboard listening on http://{HOST}:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
