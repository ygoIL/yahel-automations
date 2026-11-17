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
| `POST /admin/ds/<id>` | re-import a data store from Make |
| `GET /admin/check?only=google\|manychat\|tochat\|mail` | connectivity |

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
