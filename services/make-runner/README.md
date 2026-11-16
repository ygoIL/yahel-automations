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
