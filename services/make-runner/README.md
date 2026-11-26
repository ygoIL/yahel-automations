# make-runner

Runs exported Make.com scenario blueprints on Railway (project `yahel-reps-bot`, service `make-runner`).

* `scenarios/<id>.json` – exported blueprint + schedule + webhook id. Secrets are `__ENV:NAME__` placeholders filled from Railway variables.
* `scenarios/registry.json` – `off` / `dry` / `live` per scenario. `dry` = reads real data, logs every write/send instead of doing it.
* Webhooks: `POST https://make-runner-production.up.railway.app/hook/<make-hook-udid>` (same id as the old Make hook URL).
* Calls from one scenario to another scenario's Make webhook are routed locally once the target is `live`.

## Admin (all need `?key=$ADMIN_KEY`)
| | |
|---|---|
| `GET /admin/scenarios` | status of every scenario |
| `POST /admin/run/<id>?dry=1` | run now (dry by default; `dry=0` for real) |
| `GET /admin/runs/<id>?dry=1` | last runs with trace |
| `POST /admin/mode/<id>` `{"mode":"live"}` | switch mode (overrides registry until next change) |
| `POST /admin/lastrun/<id>` `{"at":"<ISO>"}` | repair the scheduler last-run stamp |
| `POST /admin/ds/<id>` | re-import a data store from Make |
| `GET /admin/check?only=google\|manychat\|tochat\|mail` | connectivity |

## Blocked reps (no ManyChat messages)
Reps listed in the sheet `BLOCKED_REPS_SHEET_ID` (default `1iV7g5_Gcs…` – Bezeq reps, first tab, one name per cell) get no ManyChat messages:
before every ManyChat send (`SendFlow`, `SendText`, `PerformAction` with `send_flow`) and every WhatsApp send (wa-gateway `/send` `/gate`, Green API `sendMessage`; exact field match only, so digests listing many reps still go out) the engine looks at the run's data (trigger body + row/module outputs);
if a value equals a listed name (or contains a full name of 2+ words) the send is skipped, logged as a warning `blocked rep`, and the rest of the flow continues
(so the row is still marked as handled and is not retried). Field updates/tags are not blocked. The list is re-read every 5 minutes – adding a name needs no deploy.
The service account needs view access to the sheet; on a read error the last good list is used (`/data/blocked-reps.json`).
`GET /admin/blocked-reps[?refresh=1]` shows the loaded names and the last error.

## Re-export a scenario from Make
`NODE_USE_ENV_PROXY=1 node tools/export.js <secrets.json> <scenarioId>` then `node tools/scrub-headers.js <secrets.json>`; put new secret values into Railway variables.

## Lead upload to ToChat campaigns (`src/leads/`)
Replaces the Make "add leads to campaign" flow. Uses `TOCHAT_API_KEY` / `TOCHAT_TENANT` (HTTP Basic, tenant:key).

| | |
|---|---|
| `POST /admin/leads/upload` `{"count":50,"tier":"רותח","campaign":"בוסט"}` | **dry run only**: score → iron rules → summary + `runId`. Nothing is written to ToChat. |
| `POST /admin/leads/confirm` `{"runId":"..."}` | uploads exactly the approved dry run (re-checks every lead first), batches of 200 |
| `GET /admin/leads/job/<id>` | poll a long run (calls return after ~25s with `status: running`) |
| `GET /admin/leads/log` | run log (also `/data/leads/runlog.json`; uploaded phones in `/data/leads/uploaded.json`) |
| `GET /admin/leads/campaigns` | campaign names / ids |

CLI: `ADMIN_KEY=... node tools/upload-leads.js dry 50 רותח בוסט` → `node tools/upload-leads.js confirm <runId>`.

Source: Google Sheet `LEADS_SHEET_ID` (default 1QXWDWaw…), tab `לוג שיקופים` – the service account needs view access. Optional `LEADS_LOG_SHEET_ID` (+ `LEADS_LOG_SHEET_TAB`) mirrors the run log to a sheet.

Tiers: רותח = 4+ signals and a 3+ min call; חם = 2–3; פושר = rest. Signals: 3+ min call, said what they pay, asked what's included, installation, disconnection/penalty, got a price, deferred the decision. Disqualified from the summary: deal closed, already a yes customer, no infrastructure, asked to be removed, sharp refusal, cyber campaigns. If the tier is short, the summary says so – it never fills from a lower tier.

Iron rules (ToChat status, checked before upload): open FOLLOW in any campaign; ever CLOSED; ever marked לקוח פעיל (allowed only for a פלאפון campaign) / מוטרד / להסיר / אל תתקשר / אין תשתית / כבר לקוח; deny list; a real conversation in the last 4 days (unanswered calls don't count); already in the target campaign; already uploaded by this tool. `shouldCheckWithDontCallMe` is hard-wired to `false`. `priority` stays 20 as in Make – dialing-order semantics are not verified against ToChat docs.

## Global dedupe – one customer, one rep (`src/dedupe/`)
Runs every hour in working hours – Sun–Fri 09:00–17:00 (`DEDUPE_INTERVAL_SEC`), mode `DEDUPE_MODE` = live (default) / dry / off.
Production (18/11/2026): `DEDUPE_MODE=live` is set explicitly on the make-runner service (yahel-reps-bot project). The empty
`make-runner` Railway project created by mistake on 18/11 is kept on purpose – do not delete it.
Because of ToChat's hourly openLeads row cap, the hourly pass reads only the FOCUS campaigns – פולואפים כל הזמנים, רותחים,
הזדמנות שניה, בוסט – and finds each customer's other copies via the customer record. A scan of all campaigns: `DEDUPE_FULL=1`.
At most `DEDUPE_MAX_CLOSE` (default 5000) closes per run; the rest are picked up by the next run.
Finds every phone that is open in 2+ campaigns, reads the live customer record, then:
1. open follow-up anywhere = sacred → every other copy is closed (IRRELEVANT, with a note);
   two follow-ups by different reps (edge case) → a rep listed in יעדים beats one who is not; otherwise the earlier one (lastCall/createDate) keeps the customer; no time → not closed, reported (minutes apart: still the earlier one);
2. no follow-up → keep by priority: (pinned) → הזדמנות שניה → בוסט → פולואפים כל הזמנים → רותחים → תקשורת כל החברות חדש → תקשורת כל החברות → מבצע → מצטרפים → (oldest lead). Uploads to a campaign that outranks every other open copy "pull" the customer.
Nightly full scan of all campaigns at 02:10 (`DEDUPE_FULL_TIME`); if the ToChat hourly budget runs out it waits for the next hour and continues.
WhatsApp to Steve (`DEDUPE_ALERT_PHONE`) only when a follow-up conflict was resolved, a case needs review, or the run had errors.
`POST /admin/dedupe/run?dry=1` (dry=0 for real, `notify=1` to send the message), `GET /admin/dedupe/runs`.

## Upload guard (`src/guard/`)
Every lead upload that goes through make-runner (AddLeadsToCampaign2, makeAnApiCall POST …/customers, the leads tool) skips customers that
have an open follow-up anywhere (always), or that are open in another campaign – unless the target campaign is prioritized ("pinned").
Pinned campaigns: `GET/POST /admin/dedupe/pinned {"names":[...]}`; the hourly dedupe also keeps the copy in a pinned campaign. Log: `GET /admin/upload-guard`. `UPLOAD_GUARD=off` disables.
Hourly pass reads focus + prioritized + every campaign whose status is ON (so a campaign opened during the day is covered), rotating big ones under `DEDUPE_MAX_ROWS` (default 90k).
Prioritized campaigns also come from the sheet tab `קמפיינים מתועדפים` (A2:A, first = most important) in 1-mXfg…; Steve gets a WhatsApp at 08:40 (Sun–Fri) asking which campaigns matter today.
