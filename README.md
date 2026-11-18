# yahel-automations

Automations moved off Make.com onto Railway.

## services/wa-gateway  (Railway project `yahel-reps-bot`, service `wa-gateway`)
WhatsApp hub on Green API. Replaces these Make scenarios:

| Make scenario | What it did | Now |
|---|---|---|
| 10115344 | Incoming Green API webhook → reps bot, group, Bezeq, customer replies | `POST /greenapi` |
| 10171886 | Central WhatsApp sender (primary/backup) | `POST /send` `{chatId|phone, message}` |
| 10125129 | Rep gate: Fri 16:00+ / Sat → queue | `POST /gate` `{chatId|phone, message, source}` |
| 10125131 | Sunday 08:30 queue flush | in-process scheduler |
| 10171903 | Health check every 5 min + failover | in-process scheduler (alerts by WhatsApp) |
| 10125213 / 10125215 | Rep reminders intake / sender | intake via bot, sender every minute |

Kinds still handled in Make (forwarded to the old Make hook): shikuf, disc, port, cancel, save, shikdone, advance.

All endpoints except `/health` need `?key=$GATEWAY_KEY`.

### Environment variables
`GATEWAY_KEY, REPS_BOT_URL, REPS_BOT_KEY, GREEN_P_BASE, GREEN_P_TOKEN, GREEN_B_BASE?, GREEN_B_TOKEN?, GREEN_ACTIVE, IN_WEBHOOK, ALERT_WHATSAPP, MAKE_FALLBACK_HOOK, MAKE_API_TOKEN, GOOGLE_SERVICE_ACCOUNT_JSON, DATA_DIR=/data` (volume).

### Deploy
`cd services/wa-gateway && railway up --service wa-gateway`

## Health check
`python3 tools/healthcheck.py [--hours 2] [--json]` — WhatsApp line, reps-bot, every `live` make-runner scenario
(failed runs, interval scenarios that stopped, daily/weekly runs missed today) and Make scenarios that are
scheduled in Make *and* live on Railway (would run twice). Reads keys from Railway at run time. Exit 1 = problems.

### What stays active in Make (17 Nov 2026)
* On-demand scenarios (Claude tools) – cost nothing while idle.
* Webhooks whose senders still post to the Make hook URL: 8302844 (ManyChat), 10125496, 10151077, 10151108.
* 9903461 proforma intake (Railway copy is `off`).

## tools/railway_keys.py — keys from Railway, without exposing them
The single pre-approved way (`.claude/settings.json`) for a Claude session / Cowork to use keys stored in Railway variables. Values are never printed or saved; secrets in responses are masked.

```
python3 tools/railway_keys.py send --phone 0501234567 --message "text"     # WhatsApp via wa-gateway
python3 tools/railway_keys.py call make-runner GET /admin/scenarios         # any endpoint, key added
python3 tools/railway_keys.py names wa-gateway                              # variable names only
```
