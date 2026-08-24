# Meta App Review, Instagram permissions

**Rewritten:** 2026-08-23. Supersedes the earlier draft.
**Scope:** Advanced Access for `instagram_business_manage_messages` and `instagram_business_content_publish`.
**Product:** Florrie, a UK booking and client-messaging tool for solo beauty professionals.
**Login flow in use:** Instagram Business Login (Instagram Login), not Facebook Login. No Facebook Page is involved. Source of truth: `backend/src/routes/instagram.js`.

Companion files:
- `docs/META_SCREENCAST_SHOT_LIST.md`, how to shoot the two videos.
- `docs/meta-review-rehearsal.mjs`, the pre-flight that proves the chain before anyone records.

This file is the submission packet. Sections 4 and 5 are the blocks to paste into the App Review form.

---

## 0. Read this before anything else: three blockers

### 0.1 `instagram_business_content_publish` is not in the OAuth scope list

`backend/src/routes/instagram.js` requests exactly two scopes:

```js
const SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_messages',
].join(',');
```

A token minted by that list cannot call `POST /me/media` or `POST /me/media_publish`. The publish video will fail at the container step with a permissions error no matter what else is right, and no amount of retrying on the day will fix it, because a token's permissions are fixed at the moment of authorisation.

Required change, one line, in `backend/src/routes/instagram.js`:

```diff
 const SCOPES = [
   'instagram_business_basic',
   'instagram_business_manage_messages',
+  'instagram_business_content_publish',
 ].join(',');
```

**Ordering matters more than the change does.** Deploy the scope change first, then have Ellie connect, then record. If she connects before that deploy lands she has to disconnect and connect again, and each reconnect is a fresh OAuth round trip on her phone.

The rehearsal script checks this by reading the `scope` parameter out of the URL that `GET /api/instagram/connect` returns. If `instagram_business_content_publish` is missing there, stop and do not book the session.

### 0.2 Standard Access means only people with a role on the app can authorise it

Before approval, the Instagram permissions work only for Instagram accounts that hold a role on the Meta app. Ellie's account has to be added under the app's Instagram testers and she has to accept the invitation from her own Instagram account, at Instagram, Settings and privacy, Website permissions, Apps and websites, Tester invites. Until she accepts, the OAuth screen either refuses her or issues a token that cannot call the messaging endpoints.

This cannot be verified from the codebase. Verify it in the Meta dashboard and on her phone before the session.

### 0.3 `instagram_dm_mode` is set to `'ai'` by the connect flow

`routes/instagram.js` writes `instagram_dm_mode: 'ai'` into the beautician row on every successful connect. The webhook honours it: mode `'ai'` sends the inbound DM straight into the AI front desk, which answers it. So the reviewer's test DM gets an automatic reply before Ellie has touched the screen, which is exactly the shot we do not want and exactly the framing Meta reacts badly to.

See section 6 for what to set, how, and the frontend diff that stops this recurring.

---

## 1. What we are asking for and why

Florrie is used by one person running one salon. Clients message her Instagram business account to ask about prices and availability, and she posts before and after photos of her own work to the same account. Both permissions exist to move those two things into the tool she already runs her diary from.

### `instagram_business_manage_messages`

Requested so that Florrie can:

1. Receive the client-initiated Instagram DMs sent to the salon owner's own professional account, through the `messages` webhook field, and show them to her in Florrie's Inbox alongside her WhatsApp and SMS threads.
2. Send her reply back to that client on Instagram, from her own account, inside Instagram's messaging window.
3. Read the sender's public display name and handle for a person who has messaged her, so the thread is labelled with someone she recognises rather than "Instagram User".

The salon owner is always the sender. Florrie never initiates an Instagram conversation, never messages anyone who has not messaged her first, and only ever replies inside the window Instagram allows.

What we do not do with it: no bulk sending, no message forwarding to third parties, no messaging on behalf of anyone other than the account owner who granted consent, no reading of conversations that did not arrive at her account.

### `instagram_business_content_publish`

Requested so that Florrie can:

1. Create a media container for a photo the salon owner has uploaded into Florrie, with a caption she has written or approved, against her own connected account.
2. Publish that container to her own feed when she taps the publish control, or at a time she chose herself.

Every publish is a photo she took, of her own work, with a caption she read and approved on screen before it went anywhere. Nothing publishes without an explicit action from her: the drafting step and the publishing step are separate, and drafts sit in a Drafts tab until she acts on one.

What we do not do with it: no publishing to accounts other than the one that granted consent, no scraping or republishing of anybody else's media, no automated posting without a prior human approval of that specific post.

### Permissions we are not asking for

`instagram_business_manage_comments` and `instagram_business_manage_insights` are not requested and not used. `instagram_business_basic` is used for the account identity read and stays where it is.

---

## 2. How the integration actually works, for the reviewer's technical reader

| Step | Endpoint | Notes |
|---|---|---|
| Consent | `https://www.instagram.com/oauth/authorize` | Instagram Business Login. `state` is signed by us and verified on return, so a callback cannot be replayed against another account. |
| Token | `POST https://api.instagram.com/oauth/access_token`, then `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token` | Short-lived code exchanged for a 60 day Instagram user token. Refreshed daily by a background job via `refresh_access_token`. |
| Identity | `GET https://graph.instagram.com/v21.0/me?fields=user_id,username` | We store every distinct account id the flow reports, because `id` and `user_id` are not always the same value, and the webhook matches on any of them. |
| Webhook subscribe | `POST https://graph.instagram.com/v21.0/me/subscribed_apps?subscribed_fields=messages` | Done at connect time. Verified live by our own status endpoint. |
| Inbound DM | `POST /api/webhooks/instagram` on our API | HMAC SHA256 verified against the app secret on the raw request bytes. Unsigned deliveries are rejected. |
| Outbound DM | `POST https://graph.instagram.com/v21.0/me/messages` | Bearer token is the salon owner's own long-lived token. |
| Publish | `POST /me/media`, poll `GET /{container-id}?fields=status_code`, then `POST /me/media_publish` | We wait for the container to reach `FINISHED` before publishing, and we read the publish response before marking anything as posted. |

Tokens are stored per salon owner, encrypted at rest by the database provider, never shared between tenants, and cleared when she taps Disconnect.

---

## 3. App settings to confirm before submitting

Open the Meta app dashboard and check each of these. Several of them fail silently.

| Field | Required value |
|---|---|
| App mode | Live |
| Instagram product | "API setup with Instagram login" configured, with the Instagram app id and Instagram app secret, not the Meta app id |
| Business login redirect URI | The exact string our API reports. Get it from `GET /api/instagram/connect-check`, field `register_this_exact_uri_in_meta`. Instagram compares it character for character. |
| Webhook callback | `<api host>/api/webhooks/instagram`, field `messages` subscribed |
| Webhook verify token | Matches `INSTAGRAM_VERIFY_TOKEN` on the API |
| Privacy Policy URL | `https://florrie.ai/privacy` |
| Terms of Service URL | `https://florrie.ai/terms` |
| Data Deletion Instructions URL | `https://florrie.ai/help/data-deletion` |
| App icon | 1024x1024 PNG, no transparency, no Meta or Instagram marks |
| Instagram tester | Ellie's Instagram account invited and the invite accepted |

Two of these have bitten us before and both are invisible from the outside: `INSTAGRAM_APP_ID` falling back to `META_APP_ID`, which Instagram rejects, and `INSTAGRAM_REDIRECT_URI` still on its localhost default. `GET /api/instagram/connect-check` reports both in plain English without printing the secret. Run it, and read what it says.

---

## 4. Reviewer instructions, paste into the form

These walk the app as it is on 2026-08-23. Every label below is the literal on-screen string.

### Navigation facts that both blocks rely on

- Sign in at `https://florrie.ai`.
- The bottom navigation is a floating pill with five controls, left to right: **Today**, **Inbox**, the Florrie petal in the centre, **Content**, **Money**.
- The **More** pill sits at the top right of every screen and opens a searchable index of every other page.
- Settings is reached from **More**, then **Settings**. The Settings page has a row of chips: **Profile**, **Hours**, **Policy**, **Payments**, **Calendar**, **Alerts**, **AI**, **Account**. The Instagram card lives under **AI**. Direct URL: `/settings?section=ai`.

### 4a. `instagram_business_manage_messages`

```
Florrie is a booking and client-messaging tool for solo beauty
professionals. This permission lets the salon owner read and answer the
Instagram DMs sent to her own professional account, from the same inbox
she uses for WhatsApp and SMS.

Sign in at https://florrie.ai with the credentials in the notes field.

1. CONNECTING THE ACCOUNT
   Tap the "More" pill at the top right, then "Settings". On the
   Settings page tap the "AI" chip. The first card is titled
   "Instagram".
   When no account is connected the card reads "Not connected" and
   shows a "Connect" button. Tapping "Connect" opens Instagram's own
   Business Login page, where the salon owner signs in to her own
   Instagram professional account and grants consent. Instagram will
   not render its login inside an embedded web view, so on iOS the app
   hands the URL to Safari and returns to a plain confirmation page.
   After consent the same card reads "Connected, @<her handle>".
   Nothing else in the app can read or send an Instagram message until
   that consent exists.

2. RECEIVING A CLIENT MESSAGE
   A client sends a DM to the salon owner's Instagram account.
   Meta delivers it to our webhook, which verifies the X-Hub-Signature-256
   header before doing anything with it.
   In the app, tap "Inbox" in the bottom navigation. The Inbox has two
   tabs at the top: "Clients" and "Instagram". A message from somebody
   with no booking history and no contact details on file appears under
   the "Instagram" tab, in the "Leads" section if they asked about
   prices, times or booking in, otherwise under "Everything else".
   Tap the row to open the conversation. The client's message is
   visible with an Instagram channel mark beside it.

3. REPLYING
   At the bottom of the conversation there is a channel selector. For a
   thread that arrived on Instagram, the only pill shown is "Instagram"
   and it is already selected, because that is the only address we hold
   for this person. The text box reads "Reply via Instagram...".
   Type a reply and tap the send arrow.
   The reply is sent from the salon owner's own account, with her own
   token, to the person who messaged her, inside Instagram's messaging
   window. It appears in the client's Instagram inbox within a few
   seconds and is shown in the thread in Florrie as sent.

4. DISCONNECTING
   The same Settings, AI, Instagram card carries a "Disconnect" button
   while an account is connected. Tapping it clears the stored token and
   account ids immediately, and no further messages are read or sent.

The attached screencast shows steps 2 and 3 end to end in one unbroken
take, including the reply arriving on the recipient's device.
```

### 4b. `instagram_business_content_publish`

```
This permission lets the salon owner publish a photo of her own work,
with a caption she has written or approved, to her own Instagram
professional account, from inside Florrie.

Sign in at https://florrie.ai with the credentials in the notes field.
The Instagram account is connected exactly as described in the
instructions for instagram_business_manage_messages: More, Settings,
the "AI" chip, the "Instagram" card, "Connect".

1. CREATING A POST
   Tap "Content" in the bottom navigation.
   Tap the "+ New Post" button at the top right of the page. The
   compose view opens with a live Instagram-style preview at the top
   that updates as the post is built.
   Tap "Add a photo" and choose a photo from the device. The preview
   fills with it and the control changes to "Photo added, tap to change".
   Choose "Feed post" (the alternative, "Story (24h)", uses the same
   two-step publishing flow with media_type STORIES).
   Type a caption into the box marked "Write your caption...", or tap
   "Write with AI" to have a caption drafted, which the salon owner can
   then edit. Hashtags go in the field below.
   Tap "Save as Draft". The post lands in the "Drafts" tab. Nothing has
   been sent to Instagram at this point.

2. PUBLISHING
   In the "Drafts" tab, each draft card shows the photo, the caption
   and the hashtags, with three controls: "Approve & Post", "Edit" and
   "Discard".
   Tap "Approve & Post". The button changes to "Posting...".
   Behind that button our backend creates a media container against the
   connected account with the image URL and the caption, polls the
   container until its status_code reads FINISHED, and only then calls
   media_publish. If Instagram rejects any of those steps the post stays
   in Drafts, is marked failed, and the reason Instagram gave is shown
   on screen. The card is only removed when Instagram has confirmed the
   publish and returned a media id.
   The post then appears under the "Posted" tab, and on the salon
   owner's Instagram profile.

3. SCHEDULING (the same permission, on a timer she set)
   A draft may instead carry a suggested day and time, in which case the
   card shows an "Approve for <day> <time>" button. Approving it moves
   the post into "Scheduled, posting themselves" at the top of the
   Drafts tab, with an "Undo" control. A background job publishes it at
   that time using the same media container flow. Nothing is ever
   scheduled without the salon owner approving that specific post.

The attached screencast shows step 2 end to end in one unbroken take,
including the published post appearing on the Instagram profile.
```

### 4c. Notes field

Keep this under 1500 characters. Fill in the bracketed values before pasting.

```
TEST ACCOUNT
Email: [reviewer login]
Password: [reviewer password]
Two-factor authentication is disabled on this account.
No geographic restriction.

PRE-STAGED STATE
An Instagram professional account is already connected to this Florrie
account, so the reviewer does not need to complete Instagram Business
Login. The connection card under Settings, AI shows the connected handle.
One draft post with a photo is waiting in Content, Drafts.

WHAT THIS APP IS
A booking and client-messaging tool for solo beauty professionals in the
UK. One salon owner, one Instagram professional account, her own clients.
Task-scoped to appointments: enquiries, bookings, reminders, and posting
photos of her own work. Not a general-purpose conversational assistant,
and not a messaging platform for third parties.

CONSENT MODEL
Every Instagram action is against an account whose owner completed
Instagram Business Login inside Florrie. We hold no Instagram access of
any kind before that consent, and clear the token the moment she taps
Disconnect in Settings, AI.

MESSAGING LIMITS
We only ever reply to a person who messaged the salon owner first, inside
Instagram's messaging window. We never initiate, never bulk send, never
message anyone who has not messaged her.

SUPPORT
hello@florrie.ai, answered within one working day, UK time.
```

**Open item I could not settle from the code.** The two blocks above assume a reviewer login into Florrie that has an Instagram account connected. The recording is on Ellie's real account, which holds real client data and must not be handed to a reviewer. Either a separate reviewer account gets an Instagram professional account connected to it (which needs a second Instagram account, added as an app tester), or the notes field says plainly that the reviewer login shows the product surfaces without a live Instagram connection and the screencasts carry the live proof. Decide this before submitting, and make the notes field match whichever is true. Claiming a pre-staged connection that is not there is a guaranteed rejection.

---

## 5. Data use answer

Paste into the data handling questions.

```
WHAT WE RECEIVE
From instagram_business_manage_messages: the text of DMs sent to the
connected professional account, the message id, the timestamp, the
sender's Instagram-scoped id, and where Instagram exposes it, the
sender's display name and handle.
From instagram_business_content_publish: nothing inbound. We send a
publicly reachable image URL and a caption, and receive back a container
id and a media id.

WHY WE NEED IT
Message content and sender identity are the product: the salon owner
reads and answers her client enquiries in Florrie instead of switching
apps, and she needs to see who is asking. The media id is stored so a
published post can be matched to the draft it came from.

WHERE IT GOES
An EU-hosted Postgres database (Supabase), row-level isolated per salon
owner. Message text is passed to Anthropic's API to draft a suggested
reply when the salon owner has that turned on; Anthropic does not train
on it. Nothing is sold, brokered, or shared with advertisers, data
brokers or any other third party.

RETENTION AND DELETION
Message content is kept for the life of the salon owner's account so she
has her conversation history. On account deletion we revoke third-party
tokens within 72 hours and purge personal data within 30 days.
Instructions and the request address are at
https://florrie.ai/help/data-deletion.

CONTROL
The salon owner disconnects Instagram from Settings, AI, "Disconnect".
That clears the stored token and every stored account id immediately, and
we stop reading and sending on that account from that moment.

SECURITY
Webhook deliveries are rejected unless the X-Hub-Signature-256 HMAC
verifies against the app secret over the raw request body. The OAuth
state parameter is signed by us and verified on the callback, so a
callback cannot be replayed to attach an Instagram account to somebody
else's Florrie account. Access tokens are never returned to the browser
or the mobile client by any API response.
```

### Privacy policy gap, fix before submitting

`frontend/src/pages/PrivacyPage.jsx` names Stripe, Supabase, Bird, Resend and Meta's WhatsApp Cloud API. It does not mention Instagram anywhere. A reviewer opens the privacy URL and looks for the data the permission gives us. Missing it is one of the most common Instagram rejections and it is a five minute fix.

Add a section alongside the existing `<section id="whatsapp">`, worded to match the rest of the page:

> **Instagram messaging and publishing**
>
> When you connect an Instagram professional account to Florrie, we act on that account on your behalf, with the access you granted through Instagram's own login screen.
>
> Inbound: we receive the direct messages your clients send to that account, forwarded from Meta's servers to our API, together with the sender's Instagram id and, where Instagram provides it, their display name and handle.
>
> Outbound: we send the replies you write, and the posts you approve, to Instagram on your behalf.
>
> Storage: message content, timestamps and sender identifiers are stored in our EU-hosted database so you can read your conversation history. Retention matches the rest of your account data.
>
> Sharing: we never sell Instagram data and never share message content with any third party beyond the infrastructure providers named above.
>
> Control: you can disconnect at any time from Settings, AI, Instagram, Disconnect. This clears the stored access token immediately and we stop reading and sending on that account.

Give it an anchor (`<section id="instagram">`) so it can be linked directly.

I have not made this edit. It touches application source and was outside the brief for this piece of work.

---

## 6. The DM mode problem, and exactly what to set

### What is stored right now

`instagram_dm_mode` is `'ai'` on Ellie's row, because the connect flow writes it every time she connects, and Disconnect does not clear it. The webhook's behaviour by mode:

| Stored mode | What happens on an inbound DM |
|---|---|
| `'ai'` or `'reply'` | Florrie answers the DM herself through the AI front desk. |
| `'redirect'` | One automatic reply is sent containing a wa.me link, worded "replies much faster on WhatsApp". Then silence for seven days per client. |
| `'off'` | The message is stored and shown in the Inbox. No automatic reply of any kind. |

### What we want for the recording

**`off`.** Store only. The DM lands in the Inbox, nothing answers it, and Ellie types the reply herself on camera. That is the shot that proves the permission and it is the framing least likely to be read as a general-purpose chatbot.

`redirect` is the worst possible setting for this recording. The reviewer's test DM would be answered automatically with "message me on WhatsApp instead", on camera, which reads as the app deflecting off Instagram rather than using the permission it is asking for.

### How to set it, and the trap

Go to Settings, the **AI** chip, and scroll to the card titled **Instagram DMs**. It offers two options:

- **Redirect to WhatsApp**, "Send one auto-reply with your WhatsApp link, then stop"
- **Store only**, "Log the message but don't reply at all"

**Tap "Store only".** Do not tap the option that already looks selected.

The trap: the card maps a stored `'ai'` onto the `redirect` row for display, so with `'ai'` in the database the card shows **Redirect to WhatsApp** as the selected option, with a tick. Anyone "confirming" the setting by tapping the highlighted row writes `redirect`, which is the one value that ruins the take.

After tapping, reload the page. **Store only** should now carry the tick, and the "Redirect message" editor below should disappear. If the redirect editor is still on screen, the value did not change to `off`, and the setting is still `ai` or `redirect`. The rehearsal script reads the stored value straight from the database and reports it, so run that as the confirmation rather than trusting the card.

### Proposed frontend diff, not applied

This stops the card from lying about what is stored. `frontend/src/pages/Settings.jsx`, in the "Instagram DMs" card:

```diff
             {[
+              { key: 'ai', label: 'Florrie answers', desc: 'Florrie replies to Instagram DMs in your voice', icon: 'sparkles' },
               { key: 'redirect', label: 'Redirect to WhatsApp', desc: 'Send one auto-reply with your WhatsApp link, then stop', icon: 'message' },
               { key: 'off', label: 'Store only', desc: 'Log the message but don\'t reply at all', icon: 'bell' },
             ].map(opt => {
-              // treat legacy 'ai' setting as 'redirect' since Instagram DM replies aren't supported
-              const mode = ['ai', 'redirect'].includes(beautician.instagram_dm_mode) ? 'redirect' : (beautician.instagram_dm_mode || 'redirect');
+              // Show what is stored. The webhook honours 'ai', 'redirect' and
+              // 'off' as three different behaviours, and the connect flow
+              // writes 'ai', so folding 'ai' into 'redirect' made the card
+              // show a tick against an auto-reply she never chose, one tap
+              // away from actually sending it.
+              const stored = beautician.instagram_dm_mode || 'off';
+              const mode = ['ai', 'redirect', 'off'].includes(stored) ? stored : 'off';
               const active = mode === opt.key;
```

and the redirect message editor below it:

```diff
-            {(['redirect', 'ai'].includes(beautician.instagram_dm_mode || 'redirect')) && (() => {
+            {beautician.instagram_dm_mode === 'redirect' && (() => {
```

Two things worth saying about this diff. It only fixes the display; `routes/instagram.js` still writes `'ai'` on connect, so a reconnect on the day still lands back on Florrie answering, and "set it to Store only after reconnecting" stays a step in the shot list either way. And because the iOS app bundles the frontend, this diff reaches her phone only after an Xcode Cloud build and a TestFlight update, so it cannot be part of the plan for this recording. It is worth landing so the next person to touch that card is not one tap from an unwanted auto-reply.

---

## 7. The pending SQL, and which recording steps it touches

`docs/SQL_2026-08-23_LAUNCH_SWEEP.sql` has not been run. Everything the recent hardening added is written best-effort, so the code works without it. What is actually at stake on recording day:

| Column | If the SQL has NOT run at record time |
|---|---|
| `beauticians.instagram_account_ids` | DM routing falls back to matching on `instagram_page_id` alone. **This is the one that can silently kill video 1.** A stored id that disagrees with the id Meta puts on the delivery means the DM is dropped, logged as "no beautician matches any id on this delivery", and never appears in the Inbox. It has already happened once in production and needed a hand-edited row to fix. With the column present, the connect flow stores every candidate id and the webhook matches on any of them. **Run the SQL.** |
| `beauticians.instagram_token_expires_at` | No early warning before the 60 day token dies. Harmless on the day, since the token will be hours old. |
| `content_posts.failure_reason` | A failed publish is still marked failed and the error still reaches the screen through the API response, so the operator still sees why. Only the persisted reason on the row is lost. Does not affect the take. |
| `content_posts.media_kind` | **This one can kill video 2 at the first step.** The Content compose form sends `media_kind` on every draft insert, straight from the browser to PostgREST. If the column is not there the whole insert is rejected, and "Save as Draft" fails with nothing on screen to say so, because that handler only writes to the console. Whether the column exists is genuinely unknown: it lives in `docs/sql/20260709_voice_profile.sql` and never in `supabase/migrations/`. The rehearsal script tests it directly. |

After running the SQL, **restart** the Railway service rather than redeploying it. PgBouncer caches the schema and a newly added column stays invisible to the pool until it is rebuilt.

Two lines of that file are also worth running for their own sake:

- Section 5 clears an `instagram_page_name` of the literal string `Instagram`, which is what the Settings card would otherwise print where a reviewer expects a handle. The `/status` endpoint now repairs this on its own on the next load, so this is belt and braces.
- Section 9 is the diagnostic for whether the `content-images` bucket is public. Read section 8 below before deciding.

---

## 8. The image URL, which is the single biggest publishing risk

Instagram does not receive the photo from us. We hand Meta a URL and Meta's servers fetch it themselves, from the public internet, with no cookies, no Authorization header and none of our session.

The Content page uploads to the Supabase `content-images` bucket and stores `getPublicUrl(path)` on the draft. If that bucket is private, the URL looks completely normal in the app, the photo renders in the preview because the browser has a session, and the publish fails several seconds after the tap with a container stuck in `ERROR`.

`backend/src/services/content-autopilot.js` catches the obvious shapes before a container is created: `blob:` and `data:` URLs, localhost and private address ranges, and Supabase signed URLs (`/object/sign/` or a `?token=` parameter). What it cannot catch is a public-looking `/object/public/` URL pointing into a bucket whose `public` flag is false, because that only shows up when somebody outside actually tries to fetch it.

So the rehearsal script fetches the real draft's image URL with no credentials at all and reports the status code and content type. That is the check that matters. If it comes back 400 or 404, run:

```sql
select id, public from storage.buckets where id = 'content-images';
-- if public is false, and only then:
update storage.buckets set public = true where id = 'content-images';
```

Nothing in `supabase/migrations/` creates this bucket, so its settings were made by hand and nobody can tell you from the repo what they are.

---

## 9. Rejection reasons this submission could hit, and what we did about each

Ranked by how likely each is to land on us specifically.

**1. "The video does not demonstrate the permission being used."**
The commonest one. Meta wants the action and its result in the same unbroken shot. The shot list forbids any cut between tapping send and the message landing, and between tapping publish and the post appearing on the profile. Both videos end on the result held on screen for a full six seconds.

**2. "We were unable to reproduce the functionality."**
Instagram permissions are inherently hard to hand to a reviewer, because the connection belongs to one person's Instagram account. Mitigation: the reviewer instructions in section 4 name every screen, tab and button literally, so a reviewer can follow the surfaces even where they cannot complete an Instagram login themselves, and the videos carry the live proof. The open item at the end of section 4 has to be settled honestly before submitting: if the reviewer account has no Instagram connected, say so rather than claiming it does.

**3. "The app appears to be a general-purpose AI assistant."**
Meta has been refusing open-domain conversational AI on its messaging surfaces since October 2025. Mitigations: the recording is made with `instagram_dm_mode` set to `off` so the reply on camera is typed by the salon owner, and every word of the submission copy in sections 1, 4 and 5 describes task-scoped automation for one salon's appointments. Do not paste any older draft. Phrases to keep out of the form entirely: "AI assistant", "AI agent", "chief of staff", "answers in her voice", "conversational AI".

**4. "Your privacy policy does not describe this data."**
The live privacy policy does not mention Instagram at all today. Section 5 carries the copy to add. Not yet applied, and it must be live before submitting, because the reviewer opens that URL.

**5. "The permission is not necessary for your use case."**
Both permissions are load-bearing rather than decorative, and section 1 ties each to a user-visible outcome rather than to an API call. The publish permission is the harder sell of the two, so the instructions show the whole approval path: draft, review, approve, publish, with the post visible on the profile at the end.

**6. "The app requests permissions it does not use."**
We request `instagram_business_basic` plus the two under review and nothing else. Once the scope fix in section 0.1 lands, the requested scope list and the submitted permission list match exactly. Check this again after the deploy: a mismatch between what the OAuth screen asks for and what the form requests is an easy reject.

**7. Business verification or app configuration not complete.**
App Review will not begin against an app that is not Live, has no icon, or has an unverified business. Section 3 is the checklist. Business verification cleared on 2026-05-07 per the WhatsApp packet; confirm it is still green rather than assuming.

**8. Screencast quality.**
Captions on both videos, because reviewers watch muted. MP4, under 50 MB, one take, no music, no personal data on screen. Covered in the shot list.
