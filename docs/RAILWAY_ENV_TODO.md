# Four settings only Levi can change

Everything here is blocked on a dashboard nobody but the account owner can open.
Each one has a feature already built and tested behind it, sitting idle.

The API's public address, confirmed live on 21 August:

```
https://florriebackend-production.up.railway.app
```

(`/health` returns `{"status":"ok","service":"florrie-api"}` from there. Note it
is **not** `api.florrie.ai` — that host does not serve the API.)

---

## 1. `PUBLIC_API_URL` — Railway

```
PUBLIC_API_URL = https://florriebackend-production.up.railway.app
```

**What it changes.** Booking confirmations carry a link to the calendar landing
page — one tap to add the appointment to Apple or Google Calendar, with
change-and-cancel on the same page. Without it the confirmation falls back to
the plain manage link.

**Why it is no longer urgent.** It used to be: the second WhatsApp message was
gated on this variable, so with it unset, WhatsApp clients got *no link at all*.
That is fixed — the link now falls back instead of vanishing. Setting this
upgrades the link rather than restoring it.

Not needed if it is already covered by `API_BASE_URL` or `BACKEND_URL`; the code
accepts any of the three.

---

## 2, 3, 4. Instagram — Railway

```
INSTAGRAM_APP_ID       = <from Meta > Instagram > API setup with Instagram login>
INSTAGRAM_APP_SECRET   = <same screen>
INSTAGRAM_REDIRECT_URI = https://florriebackend-production.up.railway.app/api/instagram/callback
```

**The trap.** The Instagram app id is **not** the Meta App ID. They look alike
and Instagram rejects the wrong one with an unhelpful error. If only
`META_APP_ID` is set, the code falls back to it and the connection fails —
`GET /api/instagram/connect-check` (signed in) says exactly that.

`INSTAGRAM_REDIRECT_URI` must match a registered redirect URI in the Meta
dashboard **character for character**, trailing slash included.

---

## The one that is not an environment variable: `message_echoes`

**Meta dashboard → the WhatsApp app → Webhooks → subscribe to `message_echoes`.**

Right now the webhook only receives messages *from* clients. When Ellie answers
from her own phone in WhatsApp, Florrie never sees it. Measured on 21 August:
237 open escalations, 221 of them with no reply recorded after them — which is
not 221 ignored clients, it is Florrie being blind to half of every
conversation.

Three consequences, all live today:

- Florrie cannot tell a handled thread from an abandoned one, so nothing ever
  clears itself
- Florrie drafts replies without knowing what Ellie has already said in that
  conversation
- The activity feed and every "what did Florrie save me" number is counting a
  fraction of the real traffic

This is the single highest-value change on this page and it costs one checkbox.

---

## Still needs a template edit, not a setting

`booking_confirmation_v2` has three fixed parameters and no URL button, which is
why the link travels in a second message. Adding a URL button to the template in
the Meta dashboard means a resubmission and a review wait, and would let the
confirmation be one message instead of two.
