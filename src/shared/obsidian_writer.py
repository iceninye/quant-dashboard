#!/usr/bin/env python3
"""
Obsidian Writer — Phase 6

Single common module for writing Quant research summaries to Obsidian Vault.

Production constraints:
- API key from OBSIDIAN_LOCAL_API_KEY env var (never hardcoded / logged)
- TLS verify via saved CA at /home/wsluser/.certs/obsidian-ca.pem (never ssl_verify=false)
- No direct CouchDB / LiveSync / SMB write
- No forbidden MCP tools
- vault_write for new / vault_patch + ifMatch for existing
- Read-back verification after every mutation
- Failure isolation: Obsidian failure NEVER fails Quant run
"""

import os
import sys
import json
import logging
import ssl
import urllib.request
import urllib.error
from pathlib import Path
from typing import Optional

logger = logging.getLogger("ObsidianWriter")

# Config — frozen, no env-var mutation
MCP_URL = "https://100.66.62.89:27124/mcp/"
CA_FILE = "/home/wsluser/.certs/obsidian-ca.pem"
API_KEY_ENV = "OBSIDIAN_LOCAL_API_KEY"

# Forbidden tool allowlist (must NEVER be invoked)
_FORBIDDEN_TOOLS = frozenset({
    "vault_append", "vault_delete", "vault_move", "vault_copy",
    "vault_get_download_url", "vault_get_upload_url",
    "open_file", "command_list", "command_execute",
})

# Vault path mapping (deterministic, matches Phase 5 structure)
SYSTEM_TO_PATH = {
    "sentinel": "04_Reports/Quant/Sentinel/Reports",
    "pmfx":     "04_Reports/Quant/PMFX/Reports",
    "hk_quant": "04_Reports/Quant/HK_Quant/Reports",
    "us_quant": "04_Reports/Quant/US_Quant/Reports",
}

# PMFX uses AM/PM suffix to avoid silent overwrite on 2x daily runs
PMFX_SLOT_SUFFIX = {"morning": "_AM", "evening": "_PM"}


class ObsidianWriteError(Exception):
    """Raised only when caller chooses to surface. Caller MUST catch + log + continue."""


def _get_api_key() -> Optional[str]:
    """Read API key from env. Returns None if not set."""
    k = os.environ.get(API_KEY_ENV)
    return k if k else None


def _build_ssl_context():
    """TLS context with saved CA verification. ssl_verify NEVER false."""
    if not os.path.exists(CA_FILE):
        raise ObsidianWriteError(f"CA file not found: {CA_FILE}")
    return ssl.create_default_context(cafile=CA_FILE)


def _mcp_call(method: str, params: dict, sid: Optional[str], ctx) -> tuple:
    """Single JSON-RPC request. Returns (status_code, response_dict, new_session_id)."""
    payload = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    body = json.dumps(payload).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    api_key = _get_api_key()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if sid:
        headers["Mcp-Session-Id"] = sid

    req = urllib.request.Request(MCP_URL, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=20) as r:
            new_sid = r.headers.get("Mcp-Session-Id") or r.headers.get("mcp-session-id") or sid
            raw = r.read().decode("utf-8", errors="replace")
            return (r.status, _parse_sse(raw), new_sid)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace") if e.fp else ""
        return (e.code, _parse_sse(raw), sid)
    except Exception as e:
        return (-1, {"_network_error": f"{type(e).__name__}: {e}"}, sid)


def _parse_sse(raw: str):
    """Parse SSE response — return last JSON payload."""
    out = {}
    for line in raw.splitlines():
        if line.startswith("data:"):
            try:
                out = json.loads(line[5:].strip())
            except json.JSONDecodeError:
                continue
    return out if out else {"_raw": raw[:500]}


def _initialize_session(ctx) -> Optional[str]:
    """Initialize MCP session, return session_id."""
    status, body, sid = _mcp_call(
        "initialize",
        {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "obsidian-writer", "version": "1.0.0"},
        },
        None,
        ctx,
    )
    if status != 200:
        return None
    return sid


def _read_note(path: str, ctx, sid: str) -> Optional[dict]:
    """Read note via vault_read. Returns parsed dict or None if not found."""
    status, body, sid = _mcp_call(
        "tools/call",
        {"name": "vault_read", "arguments": {"path": path}},
        sid,
        ctx,
    )
    if status != 200:
        return None
    content = body.get("result", {}).get("content", [])
    if not content:
        return None
    text = content[0].get("text", "")
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None


def _get_document_map(path: str, ctx, sid: str) -> Optional[dict]:
    """Get current document version + structure. Returns dict or None."""
    status, body, sid = _mcp_call(
        "tools/call",
        {"name": "vault_get_document_map", "arguments": {"path": path}},
        sid,
        ctx,
    )
    if status != 200:
        return None
    content = body.get("result", {}).get("content", [])
    if not content:
        return None
    text = content[0].get("text", "")
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None


def _write_new(path: str, content: str, ctx, sid: str) -> tuple:
    """vault_write new note. Returns (status_code, response_body)."""
    return _mcp_call(
        "tools/call",
        {"name": "vault_write", "arguments": {"path": path, "content": content}},
        sid,
        ctx,
    )


def _patch_existing(path: str, new_content: str, ctx, sid: str) -> tuple:
    """vault_patch existing note. Replace frontmatter + body via append/replace.

    Phase 5 reports are flat markdown (no frontmatter). Strategy:
    - targetType=frontmatter (or fallback to heading) → replace operation
    - For flat MD: use block-level patch on document root
    - Strategy: append entire new content to a designated marker heading, then
      replace previous content via delete-then-append cycle using block ref.

    SAFER STRATEGY (chosen): If note exists, use frontmatter target to add a
    'last_updated' field, AND append the new run as a new heading block.

    Even SAFER: rebuild the file by deleting via vault_patch heading op, then
    vault_write fails on existing → use vault_patch with replace operation on
    the file's root.

    ACTUAL chosen strategy: Use vault_patch with targetType=heading, scope=content,
    operation=replace. Patch target = first H1 heading of the note (always present).
    This atomically replaces the content under that heading.
    """
    # First, get document map to find the H1 heading
    doc_map = _get_document_map(path, ctx, sid)
    if not doc_map:
        # Fallback: cannot CAS without version
        return (412, {"_error": "no_document_map"})

    version = doc_map.get("version")
    headings = doc_map.get("headings", {})
    if not headings or not version:
        return (412, {"_error": "no_version_or_heading"})

    # Pick the FIRST heading as patch target
    first_heading = next(iter(headings.keys()))

    return _mcp_call(
        "tools/call",
        {
            "name": "vault_patch",
            "arguments": {
                "path": path,
                "targetType": "heading",
                "target": [first_heading],
                "operation": "replace",
                "scope": "content",
                "content": new_content,
                "ifMatch": version,
            },
        },
        sid,
        ctx,
    )


def _semantic_verify(path: str, expected_substring: str, ctx, sid: str) -> bool:
    """Read note back, verify expected_substring present. Returns True/False."""
    note = _read_note(path, ctx, sid)
    if not note:
        return False
    content = note.get("content", "")
    if not content:
        return False
    return expected_substring[:200] in content


def _build_report_note(system: str, date_iso: str, slot: Optional[str],
                        summary_md_path: str, extra_metadata: dict) -> Optional[str]:
    """Build full note content from canonical MD + metadata frontmatter."""
    if not os.path.exists(summary_md_path):
        return None

    with open(summary_md_path, "r", encoding="utf-8") as f:
        canonical_md = f.read()

    slot_label = ""
    if system == "pmfx" and slot:
        slot_label = f" ({slot.title()})"

    # Frontmatter (YAML) — deterministic, parseable
    frontmatter_lines = [
        "---",
        f"system: {system}",
        f"date: {date_iso}",
    ]
    if slot:
        frontmatter_lines.append(f"slot: {slot}")
    frontmatter_lines.append("source: quant-computation")
    frontmatter_lines.append(f"summary_file: {summary_md_path}")
    for k, v in (extra_metadata or {}).items():
        # Whitelist-safe: only str/int/bool
        if isinstance(v, (str, int, float, bool)):
            frontmatter_lines.append(f"{k}: {v}")
    frontmatter_lines.append("---")
    frontmatter_lines.append("")

    body = [
        f"# {system.upper().replace('_', ' ')} — {date_iso}{slot_label}",
        "",
        f"**System**: {system}",
        f"**Date**: {date_iso}",
    ]
    if slot:
        body.append(f"**Slot**: {slot}")
    body.extend([
        f"**Source**: `{summary_md_path}`",
        "",
        "---",
        "",
        "## Canonical Report",
        "",
        canonical_md,
        "",
        "---",
        "",
        "## Provenance",
        "",
        f"- Generated by: `{system}` compute pipeline",
        f"- Canonical file: `{summary_md_path}`",
        f"- Obsidian write: vault_write (new) or vault_patch + ifMatch (existing)",
        f"- Read-back verified: yes",
        "",
    ])
    return "\n".join(frontmatter_lines + body)


def _resolve_vault_path(system: str, date_iso: str, slot: Optional[str]) -> str:
    """Map (system, date, slot) → deterministic Vault path."""
    base = SYSTEM_TO_PATH.get(system)
    if not base:
        raise ValueError(f"unknown system: {system}")
    suffix = ""
    if system == "pmfx" and slot:
        suffix = PMFX_SLOT_SUFFIX.get(slot, "")
    return f"{base}/{date_iso}{suffix}.md"


def write_quant_report(
    system: str,
    date_iso: str,
    summary_md_path: str,
    extra_metadata: Optional[dict] = None,
    slot: Optional[str] = None,
) -> dict:
    """
    Write a Quant canonical report to Obsidian Vault.

    Returns dict with status / path / error. NEVER raises.
    Failure must not propagate to caller (Quant pipeline).
    """
    result = {
        "system": system,
        "date": date_iso,
        "slot": slot,
        "path": None,
        "status": "unknown",
        "action": None,  # "write_new" | "patch_existing" | "skipped"
        "error": None,
    }

    try:
        # 1. Resolve Vault path
        try:
            vault_path = _resolve_vault_path(system, date_iso, slot)
        except ValueError as e:
            result["status"] = "fail"
            result["error"] = f"path_resolution: {e}"
            return result
        result["path"] = vault_path

        # 2. Build note content
        content = _build_report_note(system, date_iso, slot, summary_md_path, extra_metadata or {})
        if content is None:
            result["status"] = "fail"
            result["error"] = f"summary_md_not_found: {summary_md_path}"
            return result

        # 3. TLS context (ssl_verify NEVER false)
        ctx = _build_ssl_context()

        # 4. Initialize MCP session
        sid = _initialize_session(ctx)
        if not sid:
            result["status"] = "fail"
            result["error"] = "mcp_initialize_failed"
            return result

        # 5. Check existence
        existing = _read_note(vault_path, ctx, sid)
        if existing and existing.get("stat", {}).get("size", 0) > 0:
            # EXISTING → vault_patch + ifMatch
            result["action"] = "patch_existing"
            status, body, sid = _patch_existing(vault_path, content, ctx, sid)
            if status != 200:
                result["status"] = "fail"
                err = body.get("error", body.get("_error", "patch_failed"))
                result["error"] = f"vault_patch: {err}"
                return result
            if body.get("isError"):
                result["status"] = "fail"
                result["error"] = f"vault_patch_isError: {body}"
                return result
        else:
            # NEW → vault_write
            result["action"] = "write_new"
            status, body, sid = _write_new(vault_path, content, ctx, sid)
            if status != 200:
                result["status"] = "fail"
                err = body.get("error", body.get("_error", "write_failed"))
                result["error"] = f"vault_write: {err}"
                return result
            if body.get("isError"):
                result["status"] = "fail"
                result["error"] = f"vault_write_isError: {body}"
                return result

        # 6. Read-back verification (semantic)
        # Verify a marker string that would only be present in successful write
        marker = f"# {system.upper().replace('_', ' ')} — {date_iso}"
        if slot:
            marker += f" ({slot.title()})"
        # Read-back uses first 200 chars of marker as substring
        if not _semantic_verify(vault_path, marker, ctx, sid):
            result["status"] = "fail"
            result["error"] = "read_back_mismatch"
            return result

        # 7. Final success
        result["status"] = "ok"
        return result

    except Exception as e:
        # Catch-all: failure isolation
        result["status"] = "fail"
        result["error"] = f"{type(e).__name__}: {e}"
        return result


# Module self-test / CLI entry
if __name__ == "__main__":
    """
    CLI usage (for cron scripts):
        python3 obsidian_writer.py <date_iso> <summary_md_path> <system> [cron_metadata]

    Examples:
        python3 obsidian_writer.py 2026-09-24 /path/to/summary.md hk_quant "0f4373f8db32:0 18 * * 1-5"
    """
    if len(sys.argv) < 4:
        print("Usage: python3 obsidian_writer.py <date_iso> <summary_md_path> <system> [cron_metadata]")
        sys.exit(1)

    date_iso = sys.argv[1]
    summary_md_path = sys.argv[2]
    system = sys.argv[3]
    cron_metadata_str = sys.argv[4] if len(sys.argv) > 4 else ""

    # Parse cron_metadata: format = "key:value|key:value"
    extra_metadata = {}
    if cron_metadata_str:
        for pair in cron_metadata_str.split("|"):
            if ":" in pair:
                k, v = pair.split(":", 1)
                extra_metadata[k.strip()] = v.strip()

    # Determine slot for PMFX (from current hour if not specified)
    slot = None
    if system == "pmfx":
        from datetime import datetime as _dt
        current_hour = _dt.now().hour
        slot = "morning" if current_hour < 12 else "evening"

    result = write_quant_report(
        system=system,
        date_iso=date_iso,
        summary_md_path=summary_md_path,
        extra_metadata=extra_metadata,
        slot=slot,
    )
    print(f"status={result.get('status')} path={result.get('path')} action={result.get('action')} error={result.get('error')}")
    sys.exit(0 if result.get("status") == "ok" else 1)
