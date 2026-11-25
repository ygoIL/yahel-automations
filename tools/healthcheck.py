#!/usr/bin/env python3
"""Health check for everything moved from Make to Railway.

Checks: wa-gateway (WhatsApp connected, health loop alive), reps-bot, every
`live` scenario in make-runner (errors in the window, interval scenarios that
stopped running, daily/weekly runs that were missed), and Make itself (a
scheduled scenario that is active in Make *and* live on Railway runs twice).

Secrets are read from Railway variables at run time, never stored.
Usage: python3 tools/healthcheck.py [--hours 2] [--json]
Exit code 0 = all good, 1 = problems found.
"""
import json, os, ssl, sys, urllib.request, urllib.error
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

PROJECT = "19c7f318-4dab-455b-91fa-a4eb451cc79f"   # yahel-reps-bot
ENV = "06bfd280-a128-48bc-8178-fb83d79f9eb4"       # production
SVC = {"make-runner": "70a1d0df-4dd8-43df-a691-3af96d0cc3d9", "wa-gateway": "adf91129-6fe7-4bf7-a223-b67033fb958a"}
MAKE_TEAM = 2749627
TZ = ZoneInfo("Asia/Jerusalem")
# Webhook scenarios whose senders still post to the Make hook URL: they must stay active in Make.
MAKE_WEBHOOK_KEEP = {8302844, 10125496, 10151077, 10151108}

CA = os.environ.get("SSL_CERT_FILE") or ("/root/.ccr/ca-bundle.crt" if os.path.exists("/root/.ccr/ca-bundle.crt") else None)
CTX = ssl.create_default_context(cafile=CA)
NOW = datetime.now(timezone.utc)


def http(url, data=None, headers=None, timeout=40):
    h = {"Content-Type": "application/json", "User-Agent": "curl/8.5.0", **(headers or {})}
    req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:300].decode(errors="replace")
    except Exception as e:  # network
        return 0, str(e)[:300]


def railway_vars(service_id):
    q = '{ variables(projectId:"%s", environmentId:"%s", serviceId:"%s") }' % (PROJECT, ENV, service_id)
    st, body = http("https://backboard.railway.com/graphql/v2", {"query": q}, {"Authorization": "Bearer proxy"})
    if st != 200 or not isinstance(body, dict) or "data" not in body:
        raise SystemExit(f"cannot read Railway variables: {st} {body}")
    return body["data"]["variables"]


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None


def hm(s):
    h, m = (str(s or "0:0").split(":") + ["0"])[:2]
    return int(h) * 60 + int(m)


def allowed(sch, at):
    p = at.astimezone(TZ); mins = p.hour * 60 + p.minute; wd = (p.weekday() + 1) % 7
    if sch.get("between"):
        a, b = [ts(x) if x else None for x in (sch["between"] + [None])[:2]]
        if (a and at < a) or (b and at > b):
            return False
    rs = sch.get("restrict") or []
    if not rs:
        return True
    return any((not r.get("days") or wd in r["days"]) and (not r.get("months") or p.month in r["months"])
               and (not r.get("time") or hm(r["time"][0]) <= mins <= hm((r["time"] + ["23:59"])[1])) for r in rs)


def scheduled_today(sch):
    """Datetimes (UTC) at which a daily/weekly scenario should have started today."""
    p = NOW.astimezone(TZ); wd = (p.weekday() + 1) % 7
    t = sch.get("type")
    if t == "weekly" and wd not in (sch.get("days") or []):
        return []
    if t == "daily" and not allowed(sch, NOW):
        return []
    if t not in ("daily", "weekly"):
        return []
    out = []
    for tm in ([sch.get("time")] if isinstance(sch.get("time"), str) else (sch.get("time") or ["00:00"])):
        m = hm(tm)
        out.append(p.replace(hour=m // 60, minute=m % 60, second=0, microsecond=0).astimezone(timezone.utc))
    return out


def main():
    hours = float(sys.argv[sys.argv.index("--hours") + 1]) if "--hours" in sys.argv else 2
    since = NOW - timedelta(hours=hours)
    problems, notes = [], []

    mr_vars, gw_vars = railway_vars(SVC["make-runner"]), railway_vars(SVC["wa-gateway"])
    MR = "https://" + mr_vars.get("RAILWAY_PUBLIC_DOMAIN", "make-runner-production.up.railway.app")
    GW = "https://" + gw_vars["RAILWAY_PUBLIC_DOMAIN"]
    key = mr_vars["ADMIN_KEY"]

    # --- wa-gateway / WhatsApp
    st, gw = http(GW + "/health")
    if st != 200 or not isinstance(gw, dict) or not gw.get("ok"):
        problems.append(f"wa-gateway /health {st}: {gw}")
    else:
        wa = gw.get("wa") or {}
        lc = ts(wa.get("last_check"))
        if "authorized" not in str(wa.get("last_state")):
            problems.append(f"WhatsApp not authorized: active={wa.get('active')} state={wa.get('last_state')}")
        if not lc or NOW - lc > timedelta(minutes=12):
            problems.append(f"wa-gateway health loop stale (last_check {wa.get('last_check')})")
        notes.append(f"WhatsApp: line={wa.get('active')} state={wa.get('last_state')}")

    # --- reps-bot
    st, rb = http("https://reps-bot-production.up.railway.app/health")
    if st != 200 or not (isinstance(rb, dict) and rb.get("ok")):
        problems.append(f"reps-bot /health {st}: {rb}")

    # --- make-runner scenarios
    st, scen = http(f"{MR}/admin/scenarios?key={key}")
    if st != 200 or not isinstance(scen, list):
        problems.append(f"make-runner /admin/scenarios {st}: {scen}")
        scen = []
    live = {int(s["id"]): s for s in scen if s.get("mode") == "live"}
    runs_ok = runs_err = 0
    for sid, s in sorted(live.items()):
        sch = s.get("schedule") or {}
        last_run = ts(s.get("lastRun"))
        last = s.get("last") or {}
        name = (s.get("name") or "")[:60]
        # errors in the window
        if last.get("at") and ts(last["at"]) >= since:
            st, runs = http(f"{MR}/admin/runs/{sid}?key={key}&n=50")
            if isinstance(runs, list):
                win = [r for r in runs if r.get("at") and ts(r["at"]) >= since]
                errs = [r for r in win if r.get("status") != "success"]
                runs_ok += len(win) - len(errs); runs_err += len(errs)
                if errs:
                    e = errs[0].get("error") or {}
                    msg = e.get("message") if isinstance(e, dict) else str(e)
                    problems.append(f"{sid} {name}: {len(errs)}/{len(win)} runs failed, latest {errs[0]['at'][11:16]}Z: {str(msg)[:160]}")
        # interval scenarios that stopped
        if sch.get("type") == "indefinitely":
            iv = int(sch.get("interval") or 900)
            if allowed(sch, NOW) and allowed(sch, NOW - timedelta(seconds=3 * iv)):
                if not last_run or NOW - last_run > timedelta(seconds=2 * iv + 180):
                    problems.append(f"{sid} {name}: every {iv // 60} min but last run {s.get('lastRun')}")
        # missed daily/weekly runs today
        for due in scheduled_today(sch):
            if NOW - due > timedelta(minutes=15) and (not last_run or last_run < due - timedelta(minutes=1)):
                problems.append(f"{sid} {name}: scheduled {due.astimezone(TZ):%H:%M} today, no run (last {s.get('lastRun')})")
    notes.append(f"make-runner: {len(live)} live scenarios, {runs_ok} ok / {runs_err} failed runs in the last {hours:g}h")

    # --- global dedupe (must survive every deploy)
    st, dd = http(f"{MR}/admin/dedupe/runs?n=1&key={key}")
    if st != 200 or not isinstance(dd, list):
        problems.append(f"DEDUPE MISSING: /admin/dedupe/runs -> {st} (a deploy without src/dedupe removed it; redeploy from a branch that has it)")
    elif dd and ts(dd[0].get("at")) and NOW - ts(dd[0]["at"]) > timedelta(hours=3) and allowed({"restrict": [{"days": [0, 1, 2, 3, 4, 5], "time": ["10:30", "17:30"]}]}, NOW):
        problems.append(f"dedupe has not run since {dd[0]['at']}")
    else:
        notes.append(f"dedupe: last run {dd[0]['at'][11:16]}Z" if dd else "dedupe: no runs yet")

    # --- Make: scheduled scenarios running in both places
    st, mk = http(f"https://eu2.make.com/api/v2/scenarios?teamId={MAKE_TEAM}&pg%5Blimit%5D=500&cols%5B%5D=id&cols%5B%5D=name&cols%5B%5D=isActive&cols%5B%5D=scheduling",
                  headers={"Authorization": "Token proxy"})
    if st == 200 and isinstance(mk, dict):
        active = [x for x in mk["scenarios"] if x.get("isActive")]
        for x in active:
            t = (x.get("scheduling") or {}).get("type")
            if x["id"] in live and t != "on-demand" and x["id"] not in MAKE_WEBHOOK_KEEP:
                problems.append(f"DUPLICATE: {x['id']} {x['name'][:50]} is active in Make ({t}) and live on Railway")
        notes.append(f"Make: {len(active)} active scenarios")
    else:
        notes.append(f"Make API not checked ({st})")

    if "--json" in sys.argv:
        print(json.dumps({"at": NOW.isoformat(), "ok": not problems, "problems": problems, "notes": notes}, ensure_ascii=False, indent=1))
    else:
        print(f"Health check {NOW.astimezone(TZ):%Y-%m-%d %H:%M} (Israel), window {hours:g}h")
        for n in notes:
            print("  ·", n)
        print("ALL OK" if not problems else f"{len(problems)} PROBLEM(S):")
        for p in problems:
            print("  ✗", p)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
