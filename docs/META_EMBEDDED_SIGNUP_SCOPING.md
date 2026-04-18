# Meta Embedded Signup — Scoping & Migration Plan

**Status:** Not started. Blocked on Meta Tech Provider approval.
**Owner:** Levi
**Last updated:** 2026-04-18

## TL;DR

Today every beautician walks through our hand-rolled 4-step Meta phone-number
flow (`add_number → request_code → verify_code → register`). It works but
breaks in too many places — wrong country code, name collision, on personal
WhatsApp, cooldown after a previous attempt, Meta's `register` endpoint
returning 200 OK while the number stays `PENDING`.

Embedded Signup ("ES") replaces the entire flow with a Meta-hosted modal: the
beautician clicks a button, signs in to Facebook, picks (or creates) a
WhatsApp Business Account, picks the number, verifies it through Meta's UI,
and we get a webhook with the finished `phone_number_id` and a
sharing-permission token. Most of the failure modes we hand-handle today
literally cannot happen in ES because Meta resolves them in the modal.

The reason we don't already use it: ES requires a **Tech Provider** approval
from Meta. We're an ISV under our own WABA right now, not a Tech Provider.

## What ES gives us (vs. our current flow)

| Concern                          | Hand-rolled flow                   | Embedded Signup                  |
|----------------------------------|------------------------------------|----------------------------------|
| Number on personal WhatsApp      | Generic 100 from Meta, we diagnose | Meta surfaces it inline          |
| Country code wrong               | Generic 100, we diagnose           | Meta validates client-side       |
| Verified name collision          | We retry with `allow_duplicate`    | Meta picks it from Business Mgr  |
| Cooldown after previous attempt  | We park retry, poll Meta           | Meta blocks the modal cleanly    |
| `register` 200 but PENDING       | Polled via `/activation-status`    | Meta only returns CONNECTED      |
| Onboarding bounces / drops       | High — 4 manual steps + SMS OTP    | Single modal, Meta-hosted        |
| Per-beautician WABA isolation    | Single shared WABA, our problem    | Each beautician gets their own   |

ES is also the only path that scales past ~25 numbers on a single WABA
without manual intervention from Meta.

## What ES requires us to do

### 1. Tech Provider approval (the long pole)

We need to be enrolled as a **WhatsApp Business Solution Provider (BSP)** OR
as a **Tech Provider** under Meta's Marketing Partners programme. Concretely:

- Submit our app to Meta App Review for the `whatsapp_business_management`
  and `whatsapp_business_messaging` permissions in **Advanced Access** mode.
- Pass Meta's Business Verification (we did this for Cloud API already, but
  we'd need to re-verify under the Tech Provider classification).
- Complete a Solution Partner application at
  https://developers.facebook.com/docs/whatsapp/embedded-signup
- Demo our integration to Meta's solution-engineer team in a screen-share.
- Sign Meta's Tech Provider terms (separate from the Cloud API ToS we're on).

Realistic timeline based on what other founders have reported: **6–12 weeks
end to end**, with Meta business verification being the slowest leg.

### 2. Frontend integration

The Meta JS SDK has to be loaded on the page that triggers signup. The
button calls `FB.login()` with our app id and the WhatsApp config id. The
modal handles everything end-to-end.

```html
<script async defer
  src="https://connect.facebook.net/en_US/sdk.js"></script>
```

```js
FB.init({
  appId: import.meta.env.VITE_META_APP_ID,
  cookie: true,
  xfbml: true,
  version: 'v21.0',
});

function launchSignup() {
  FB.login(
    response => {
      if (response.authResponse) {
        // POST response.authResponse.code to our backend; backend exchanges
        // it for a long-lived token and links the phone_number_id to this
        // beautician.
        api.post('/api/whatsapp/embedded-signup/callback', {
          code: response.authResponse.code,
        });
      }
    },
    {
      config_id: import.meta.env.VITE_META_WA_CONFIG_ID,
      response_type: 'code',
      override_default_response_type: true,
      extras: {
        feature: 'whatsapp_embedded_signup',
        sessionInfoVersion: 2,
        setup: {
          // pre-fill what we can to shave seconds off the modal
          business: {
            name: '$BEAUTICIAN_BUSINESS_NAME',
          },
        },
      },
    }
  );
}
```

### 3. Backend integration

A new route, `POST /api/whatsapp/embedded-signup/callback`, receives the
short-lived code and:

1. Exchanges it for an access token using
   `GET /v21.0/oauth/access_token?...client_secret=$META_APP_SECRET`.
2. Calls `GET /v21.0/{token-debug}` to confirm scopes contain
   `whatsapp_business_management` and `whatsapp_business_messaging`.
3. Calls `GET /v21.0/{user_id}/businesses` to find the WABA the user picked
   in the modal.
4. Calls `GET /v21.0/{waba_id}/phone_numbers` to find the activated number.
5. Stores `whatsapp_phone_id`, `whatsapp_phone`, `whatsapp_waba_id`, and
   `whatsapp_connected=true` directly. No OTP step, no register step.
6. Subscribes Florrie's webhook to that WABA via
   `POST /v21.0/{waba_id}/subscribed_apps`.

We can keep `whatsapp_diagnostics` for parity, but the row count should drop
to almost zero because Meta resolves issues in-modal.

### 4. Migration approach

Run both flows side by side:

- New beauticians get the ES button by default (Eligible-only feature flag).
- Existing connected beauticians keep working — their `whatsapp_phone_id`
  on Florrie's WABA stays valid until they disconnect.
- Add a "Move to your own WhatsApp Business Account" CTA in Settings for
  power users who want to migrate (this also unlocks higher messaging tiers
  Meta gates per-WABA).
- After ~3 months, default the Reset flow to ES so retries also use the
  better path.

## What's blocking us right now

1. **Tech Provider application not submitted.** The Meta dashboard for
   developer programmes shows we're enrolled as a regular Cloud API user.
   Need to fill in the BSP/Tech Provider application.
2. **Privacy policy + terms updates.** Meta requires explicit ES-related
   language. Our current marketing site privacy page predates the move to
   WhatsApp Cloud API.
3. **Demo video / sample integration.** Meta wants to see a working sandbox
   environment they can poke. We could spin this up in a few days once the
   approval pipe is moving.

## Effort estimate

| Phase                                       | Effort           | Blocker?           |
|---------------------------------------------|------------------|--------------------|
| Submit Tech Provider application            | 1 day            | Needs Levi         |
| Wait on Meta business re-verification       | 4–8 weeks        | External           |
| Build sandbox integration for Meta to test  | 3 days           | After verification |
| Wire ES JS SDK + new backend route          | 2–3 days         | After approval     |
| Side-by-side migration UI in Settings       | 1 day            | After approval     |
| Cut over default flow + retire OTP path     | 1 day            | After ~3 months    |

## Decision

**Don't start building until the Tech Provider application is submitted and
acknowledged.** The hand-rolled flow plus the diagnostics + retry worker we
just shipped is good enough for the next ~6 weeks of pilot users (Ellie +
the next handful). Levi to file the Tech Provider application this week so
the clock starts.

## References

- Embedded Signup overview: https://developers.facebook.com/docs/whatsapp/embedded-signup
- Tech Provider programme: https://developers.facebook.com/docs/marketing-api/business-management-api
- WABA limits: https://developers.facebook.com/docs/whatsapp/cloud-api/get-started
- BSP solution partner application: https://developers.facebook.com/products/whatsapp/

## Open questions

- Do we need our own dedicated app id, or can we extend the existing Cloud
  API app's permissions?
- Per-beautician WABA means per-beautician webhook subscription. Do we need
  to refactor `routes/webhooks.js` to handle multiple WABA ids, or can we
  centralise on Florrie's app subscribing to all WABAs we onboard?
- For pricing: each beautician's WABA is billed to their own Meta business
  manager. Today we eat the Meta cost in the £29/mo. Under ES the
  beautician sees the bill. We need to decide: do we pre-tunnel that into
  our pricing, or shift the line item to "+ Meta WhatsApp fees at cost"?
