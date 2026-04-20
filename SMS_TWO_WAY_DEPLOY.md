# 2-Way SMS — Deploy Steps

Code is in. Four manual steps to flip it live:

## 1. Buy a Bird UK virtual mobile number

Log into the Bird/MessageBird dashboard → Numbers → Buy a number → UK → Mobile
(not landline, not toll-free). Roughly £4/mo. Any UK mobile prefix works.

Copy the E.164-formatted number, e.g. `+447700900123`.

## 2. Railway env vars

Set in Railway → Florrie backend service → Variables:

- `BIRD_ORIGINATOR` = the number you just bought (e.g. `+447700900123`)
- `BIRD_WEBHOOK_TOKEN` = a random secret string (use `openssl rand -hex 24`)

If `BIRD_API_KEY` isn't already set, add it too.

Redeploy after saving. (Not just restart — env var changes need a redeploy.)

## 3. Supabase migration

Open Supabase → SQL editor → paste the contents of
`supabase/migrations/046_sms_originator_widen.sql` → run.

This widens `beauticians.sms_originator` from VARCHAR(11) to VARCHAR(20)
so it can hold a phone number.

## 4. Bird inbound webhook URL

In the Bird dashboard → Flows (or the classic Inbound SMS webhook settings) →
add a new webhook for inbound SMS to your purchased number:

```
https://api.florrie.ai/api/webhooks/bird-sms?token=YOUR_BIRD_WEBHOOK_TOKEN
```

Method: POST. Payload: JSON (Bird v2) or form-urlencoded (classic) — the handler
accepts both.

## Smoke test

After all four steps:

1. Visit `/sms` in the Florrie app. Sender should show the phone number and
   the chip should read "2-way — clients can reply".
2. Hit "Send Test SMS" with your own phone. Confirm receipt.
3. Reply to the SMS from your phone. Within a few seconds:
   - Railway logs should show `Front Desk processed Bird SMS`
   - The reply should appear in `/inbox`
4. The AI's response should arrive back at your phone.

## Rollback

To fall back to the 1-way alphanumeric sender, set `BIRD_ORIGINATOR=Florrie`
in Railway and redeploy. The migration is forward-compatible — no schema
rollback needed.
