# Template Send 132001 Investigation

Date: 2026-05-18
Owner: Florrie backend
Pilot impact: Blocks the WhatsApp half of the Ellie pilot. SMS is unaffected.

## The error

```
Meta /messages POST -> 400
"Template name does not exist in the translation:
 template name (generic_message) does not exist in en"
code: 132001
```

This fires every time we try to send a template from `phone_number_id`
`1073724175829484` (Ellie's `+44790388XXXX (redacted)`, verified_name `Ellindigo`) against
WABA `1279846344245554`, even though `GET /1279846344245554/message_templates`
returns six APPROVED templates including `generic_message`. Languages tried:
`en`, `en_US`, `en_GB`. All three return 132001.

The previous blocker (Meta 141006, payment-method-BLOCKED) cleared earlier today.

## Known facts about the phone

- `status: CONNECTED`
- `account_mode: LIVE`
- `code_verification_status: VERIFIED`
- `name_status: DECLINED` (Meta rejected "Ellindigo" as a verified_name)
- `whatsapp_business_account` field on the phone has NOT been confirmed yet.
  That is the gap this investigation closes.

## Hypotheses

| # | Hypothesis | Likelihood | How we test it |
|---|------------|------------|----------------|
| 1 | Phone's parent WABA differs from `WHATSAPP_WABA_ID`. Templates exist on the env WABA, phone reads from a different one. | Medium-High | `GET /{phone_id}?fields=whatsapp_business_account` then compare. |
| 2 | Templates not propagated to the specific phone yet (rare, documented). | Low | Wait + retry. No code change can disprove this. |
| 3 | Language enum on the wire must match the template's exact language code, not a fuzzy match. `en` vs `en_US` matters. | Medium | Probe the language stored on the template object, then send using that exact value. |
| 4 | `name_status: DECLINED` gates all outbound template sends until a verified_name is APPROVED. | Medium | Send error code is the test. If we fix WABA mismatch and language and still see 132001, suspect this. |
| 5 | The 6 templates in the WABA list are actually PENDING / REJECTED and the dashboard is lying. | Low | The list endpoint returns `status` per template; read it. |

Hypothesis 1 is the highest prior because the WABA-mismatch failure mode is
silent on the send side: Meta does not return "wrong WABA", it returns
"template not found in en" because, from the phone's WABA perspective, that is
literally true.

## Diagnostic endpoint shipped

`GET /api/whatsapp/template-debug` (auth-gated, read-only)

Query params:
- `name` template name. Defaults to `generic_message`.
- `language` optional. Forces one language code; omitted = sweep.
- `to` optional E.164 recipient. Defaults to the caller's own number.

Returns:
- `env_waba_id` what `WHATSAPP_WABA_ID` is set to
- `phone_meta` the phone object including `whatsapp_business_account`
- `phone_parent_waba_id` the WABA Meta thinks owns this phone
- `waba_match` boolean
- `template_in_list` matches in `GET /{env_waba}/message_templates?name=...`
- `template_in_phone_waba` same lookup against the phone's actual WABA
   (only populated when the two WABAs disagree, which is the smoking gun)
- `send_attempts[]` full request body + Meta response for every language tried
- `name_status_warning` true when `name_status !== APPROVED`
- `verdict` one of:
  - `send_succeeded`
  - `waba_mismatch`
  - `template_not_on_waba`
  - `name_status_declined`
  - `language_enum_mismatch`
  - `unknown`

No DB writes, no side effects beyond the live send probe (which will deliver
an actual message if it succeeds, so use a recipient you control).

## How Levi calls it

From the browser, while logged in as Ellie (or any beautician whose WhatsApp
is connected to the same WABA):

```js
fetch('/api/whatsapp/template-debug?name=generic_message', {
  credentials: 'include',
})
  .then((r) => r.json())
  .then(console.log);
```

Or with a specific language:

```js
fetch('/api/whatsapp/template-debug?name=generic_message&language=en_US', {
  credentials: 'include',
}).then((r) => r.json()).then(console.log);
```

## Reading the output

1. **If `waba_match === false`**, root cause is hypothesis 1. The env var
   `WHATSAPP_WABA_ID` points at a different WABA than the phone is parented to.
   Either fix the env on Railway or move the phone in Business Manager. The
   `template_in_phone_waba` field will tell you whether `generic_message`
   exists on the phone's actual WABA.
2. **If `waba_match === true` and `template_in_list.match_count === 0`**,
   root cause is the template never made it onto this WABA. Create or rename.
3. **If `waba_match === true` and there's a match with `language: "en"` but
   no send_attempt succeeds**, root cause is either hypothesis 3
   (language-enum mismatch on the wire format) or hypothesis 4
   (`name_status: DECLINED` blocking sends). The `verdict` field separates
   the two.
4. **If `verdict === language_enum_mismatch`**, the `notes` field tells you
   what language(s) the WABA list reports vs what was tried. Action: log a
   Meta support ticket with the `fbtrace_id` from any send_attempt's
   `meta_error.fbtraceId`. Meta-side issue, not ours.
5. **If `verdict === name_status_declined`**, action: pick a new verified_name
   in Business Manager and resubmit. Until it's APPROVED, template sends will
   keep failing with 132001 even though the template exists.

## What this endpoint does NOT do

- Does not change any DB row.
- Does not retry sends in a loop.
- Does not touch SMS or any non-WhatsApp surface.
- Does not auto-fix the env var or move phones between WABAs. Diagnostic only.

## Follow-ups (only after we have the output)

- If hypothesis 1 wins: update the env var or move the phone, then re-run the
  endpoint to confirm.
- If hypothesis 4 wins: reset verified_name and re-verify, then re-run.
- If neither: open a Meta direct support ticket with the `fbtrace_id` from
  the `send_attempts[].meta_error.fbtraceId` payload.
