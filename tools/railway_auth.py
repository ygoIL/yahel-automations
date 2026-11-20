"""Railway API auth for the tools in this folder, shared by healthcheck.py and railway_keys.py.

Order:
  1. RAILWAY_TOKEN / RAILWAY_API_TOKEN environment variable
  2. the token saved by `railway login` on this computer (~/.railway/config.json)
  3. "proxy" - a Claude cloud session, where the egress proxy injects the real token

The token is only returned to the caller for the Authorization header; it is never printed.
"""
import json
import os
import shutil
import subprocess
from pathlib import Path


def _cli_token():
    cfg = Path.home() / ".railway" / "config.json"
    if not cfg.exists():
        return None
    # `railway whoami` refreshes an expired OAuth access token in the config file.
    exe = shutil.which("railway")
    if exe:
        try:
            subprocess.run([exe, "whoami"], capture_output=True, timeout=30)
        except Exception:
            pass
    try:
        user = json.loads(cfg.read_text(encoding="utf-8")).get("user") or {}
    except Exception:
        return None
    return user.get("accessToken") or user.get("token")


def railway_token():
    return os.environ.get("RAILWAY_TOKEN") or os.environ.get("RAILWAY_API_TOKEN") or _cli_token() or "proxy"
