#!/usr/bin/env python3
"""Call yahel services on Railway with their own keys, without exposing the keys.

The single pre-approved entry point (see .claude/settings.json) for anything that
needs a key stored in Railway service variables. Railway auth comes from the
session proxy, RAILWAY_TOKEN, or a local `railway login` (see railway_auth.py). Key values are never printed or written
to disk: they live only in memory, and any occurrence of a secret value in a
response is masked before output.

Usage:
  python3 tools/railway_keys.py names <service>
  python3 tools/railway_keys.py send --phone 0501234567 --message "text"
  python3 tools/railway_keys.py send --chat 972501234567@c.us --message "text"
  python3 tools/railway_keys.py call <service> <METHOD> <path> [--data JSON|@file]

Services: wa-gateway (GATEWAY_KEY), make-runner (ADMIN_KEY), reps-bot (REPS_BOT_KEY via wa-gateway vars).
Examples:
  python3 tools/railway_keys.py call make-runner GET /admin/scenarios
  python3 tools/railway_keys.py call make-runner POST /admin/run/9900449?dry=1
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

from railway_auth import railway_token

API = "https://backboard.railway.com/graphql/v2"
PROJECT = os.environ.get("RAILWAY_PROJECT", "yahel-reps-bot")
ENVIRONMENT = os.environ.get("RAILWAY_ENVIRONMENT", "production")
UA = "yahel-automations-tools/1.0"

# service -> (service whose variables hold the key, variable name, base-url variable or None)
KEYS = {
    "wa-gateway": ("wa-gateway", "GATEWAY_KEY", None),
    "make-runner": ("make-runner", "ADMIN_KEY", None),
    "reps-bot": ("wa-gateway", "REPS_BOT_KEY", "REPS_BOT_URL"),
}


def die(msg, code=1):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


def gql(query, variables=None):
    headers = {"Content-Type": "application/json", "User-Agent": UA}
    token = railway_token()
    if token != "proxy":
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(API, json.dumps({"query": query, "variables": variables or {}}).encode(), headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            out = json.load(r)
    except urllib.error.HTTPError as e:
        die(f"Railway API HTTP {e.code}")
    if out.get("errors"):
        die("Railway API: " + "; ".join(x.get("message", "?") for x in out["errors"]))
    return out["data"]


def resolve():
    data = gql("""{ me { workspaces { projects { edges { node { id name
        environments { edges { node { id name } } }
        services { edges { node { id name
          serviceInstances { edges { node { environmentId domains {
            serviceDomains { domain } customDomains { domain } } } } } } } } } } } } } }""")
    for ws in data["me"]["workspaces"]:
        for p in ws["projects"]["edges"]:
            p = p["node"]
            if p["name"] != PROJECT:
                continue
            env = next((e["node"]["id"] for e in p["environments"]["edges"] if e["node"]["name"] == ENVIRONMENT), None)
            if not env:
                die(f"environment {ENVIRONMENT} not found in {PROJECT}")
            services = {}
            for s in p["services"]["edges"]:
                s = s["node"]
                dom = None
                for i in s["serviceInstances"]["edges"]:
                    i = i["node"]
                    if i["environmentId"] == env:
                        ds = i["domains"]["customDomains"] + i["domains"]["serviceDomains"]
                        dom = ds[0]["domain"] if ds else None
                services[s["name"]] = {"id": s["id"], "domain": dom}
            return p["id"], env, services
    die(f"project {PROJECT} not found")


def variables(project, env, service_id):
    d = gql("query($p:String!,$e:String!,$s:String!){ variables(projectId:$p, environmentId:$e, serviceId:$s) }",
            {"p": project, "e": env, "s": service_id})
    return d["variables"] or {}


def mask(text, secrets):
    for s in sorted({s for s in secrets if s and len(s) >= 6}, key=len, reverse=True):
        text = text.replace(s, "***")
        text = text.replace(urllib.parse.quote(s, safe=""), "***")
    return text


def request(method, url, body, secrets):
    data = None
    headers = {"User-Agent": UA}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            status, text = r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        status, text = e.code, e.read().decode("utf-8", "replace")
    except urllib.error.URLError as e:
        die(mask(f"request failed: {e.reason}", secrets))
    print(f"HTTP {status}")
    print(mask(text, secrets))
    return 0 if 200 <= status < 300 else 2


def call(service, method, path, body):
    if service not in KEYS:
        die(f"unknown service {service}; choose from {', '.join(KEYS)}")
    project, env, services = resolve()
    holder, key_var, base_var = KEYS[service]
    if holder not in services:
        die(f"service {holder} not found in {PROJECT}")
    v = variables(project, env, services[holder]["id"])
    key = v.get(key_var)
    if not key:
        die(f"{key_var} is not set on {holder}")
    if base_var:
        base = (v.get(base_var) or "").rstrip("/")
        if not base and services.get(service, {}).get("domain"):
            base = "https://" + services[service]["domain"]
    else:
        dom = services.get(service, {}).get("domain")
        base = "https://" + dom if dom else ""
    if not base:
        die(f"no public domain for {service}")
    if not path.startswith("/"):
        path = "/" + path
    u = urllib.parse.urlsplit(base + path)
    q = urllib.parse.parse_qsl(u.query) + [("key", key)]
    url = urllib.parse.urlunsplit((u.scheme, u.netloc, u.path, urllib.parse.urlencode(q), ""))
    return request(method, url, body, list(v.values()))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    n = sub.add_parser("names", help="list variable NAMES of a service (never values)")
    n.add_argument("service")
    s = sub.add_parser("send", help="send a WhatsApp message through wa-gateway /send")
    g = s.add_mutually_exclusive_group(required=True)
    g.add_argument("--phone")
    g.add_argument("--chat")
    s.add_argument("--message", required=True)
    c = sub.add_parser("call", help="call a service endpoint with its key")
    c.add_argument("service")
    c.add_argument("method")
    c.add_argument("path")
    c.add_argument("--data", help="JSON body, or @file")
    a = ap.parse_args()

    if a.cmd == "names":
        project, env, services = resolve()
        if a.service not in services:
            die(f"service {a.service} not found; have {', '.join(services)}")
        for k in sorted(variables(project, env, services[a.service]["id"])):
            print(k)
        return 0
    if a.cmd == "send":
        body = {"message": a.message}
        body["chatId" if a.chat else "phone"] = a.chat or a.phone
        return call("wa-gateway", "POST", "/send", body)
    body = None
    if a.data:
        raw = open(a.data[1:], encoding="utf-8").read() if a.data.startswith("@") else a.data
        try:
            body = json.loads(raw)
        except ValueError:
            die("--data is not valid JSON")
    return call(a.service, a.method, a.path, body)


if __name__ == "__main__":
    sys.exit(main())
