# Customer message connections

Customers can start WhatsApp or mailbox setup from `/connections`. Gmail and Microsoft use separate OAuth clients, provider sign-in, single-use database state and PKCE. Neither connection asks a salon to share its password with Florrie. The new features remain gated until a demo salon completes a provider-backed test.

## Email

`EMAIL_GOOGLE_ENABLED` and `EMAIL_MICROSOFT_ENABLED` must equal `true`. Each needs `CLIENT_ID`, `CLIENT_SECRET` and `REDIRECT_URI` under its prefix. Redirects are `https://api.florrie.ai/api/email/callback/google` and `/microsoft`. Set `EMAIL_CONNECTIONS_SALONS` to the demo salon UUID before enabling either provider. Empty allowlists permit all salons; do not use an empty list before launch approval. `EMAIL_CONNECTIONS_KEY` is 32 random bytes encoded as 64 hex characters; the existing WhatsApp encryption key is a supported fallback. Secrets belong in backend variables only.

Gmail requests gmail.readonly and gmail.send. Microsoft requests delegated User.Read, Mail.Read, Mail.Send and offline_access. No application-wide mailbox permission or tenant-wide admin consent is needed. Google requires restricted-scope verification and potentially an independent security assessment. Microsoft's new multitenant-app warning requires publisher verification to be resolved before public rollout. Registration alone does not establish approval.

The worker imports new text emails from Inbox. Existing clients are the default filter; a dedicated business inbox can include new senders. It does not download attachments or import newsletters. Imported messages bypass the booking/action engine. Optional Anthropic drafts use the read-only answer preview and require explicit consent. Inbox and Outbox sends need an explicit original message and salon approval. Sent-thread checks catch replies already made in the provider app. Alternate Reply-To addresses require review in the provider app.

The durable reply attempt permits retry only after a definite rejection. A timeout, server error or failed receipt save remains unconfirmed; users must check Sent rather than blindly repeat it. Microsoft acceptance is not a delivery receipt. Disconnect cancels unfinished sign-in, changes the generation and removes credentials. Imported conversations remain until deleted. Users can also revoke access with their provider.

## WhatsApp Business app

The existing Cloud API path remains supported. Business app coexistence requires `WHATSAPP_BUSINESS_APP_ENABLED=true` plus a non-empty `WHATSAPP_BUSINESS_APP_SALONS` allowlist. Keep it demo-only until tested. The signed-in session binds the mode; browser events cannot change it. Meta must return a valid customer grant, the selected WABA and one unambiguous, linked Cloud API phone. This path never calls `/register` or changes its PIN.

Required app webhooks: messages, account_update, history, smb_app_state_sync and smb_message_echoes. Meta setup uses `featureType=whatsapp_business_app_onboarding` and `sessionInfoVersion=3`; this is distinct from Meta's deprecated signup-flow versions. History and contact sync requests are one-time, within 24 hours. Unknown results require review rather than an unsafe automatic retry. Encrypted webhook storage precedes acknowledgment. Owner echoes are recorded as human context, historical inbound messages do not trigger automatic replies, and imports deduplicate. Unsupported phone-less identities remain review items.

Before public availability, prove owner replies suppress stale automation, history opt-out works, deletion/reconnect preserve isolation, and messages sent in either app reach the other. The demo business-account quota remains a Meta support dependency. Do not migrate Ellie's or Levi's personal number to bypass it.

## Validation and rollout

Both SQL migrations passed isolated PGlite tenancy, callback, generation, duplicate-message, reply-attempt and legacy WhatsApp checks. The full backend suite passed 4,174 tests; six additional provider-send recovery tests passed separately. The frontend build and complete channel browser suite passed, including narrow-screen email states and both WhatsApp completion orders. Provider tests use fixtures; they are not proof of live delivery.

Production migrations were applied as 20261116184422 and 20261116184431. All six new tables have RLS and no direct anon/authenticated grants. Existing WhatsApp connection count remains one, with zero business-app connections. Existing advisor warnings remain outside this change.

Public release requires provider approval, a dedicated demo mailbox consent, recorded incoming/reply/reconnect/disconnect proof, and an iPhone browser-return test. No salon mailbox was connected during implementation. No external message was sent.
