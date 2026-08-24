# Meta screencast shot list, Instagram permissions

**Written:** 2026-08-23.
**Two videos, one per permission.** Video A: `instagram_business_manage_messages`. Video B: `instagram_business_content_publish`.
**Companion:** `docs/META_APP_REVIEW_INSTAGRAM.md` for the submission copy, `docs/meta-review-rehearsal.mjs` for the pre-flight.

Read the whole file once before you set anything up. Section 1 has three items that take days if they are wrong and thirty seconds if you check them first.

---

## 0. Where to record each video, and why

**Both videos: a desktop browser at `https://florrie.ai`. Not the phone.**

The reason is the iOS app. It bundles the frontend, so Ellie's TestFlight build carries whatever frontend shipped in the last Xcode Cloud build, not what is on the web today. Everything the recent hardening changed on screen is new frontend code:

- the Settings Instagram card that prints `● Connected, @handle`, the reconnect prompt, and the "Instagram is not sending your DMs here yet" warning
- the Publish button that keeps the draft card on screen when Instagram rejects the post

That second one is why video B in particular must not be shot on the phone. On the old bundle, a publish that Instagram refuses still removes the card from the list and reloads the Posted tab. On camera that looks exactly like a successful publish, and you would only find out afterwards that nothing reached the profile. On the web build, a refused publish leaves the card in place and prints the reason Instagram gave.

A browser also buys three things Meta reviewers respond to: the URL bar is visible in every frame, the whole loop for video A fits inside one screen recording on one machine, and the picture is sharp at 1080p without filming a phone.

**What still happens on the phone.** Ellie reconnects Instagram once. She can do that on her phone, and it is fine: the connection lives on her account, not on the device, so a browser session signed in as her sees it immediately. If she is willing to do the reconnect in the desktop browser instead, prefer that: the web flow redirects straight back to `/settings?section=ai` and the card updates in place, where the iOS flow hands the login to Safari and comes back to a plain "go back to the app" page.

**If a desktop recording is genuinely not possible** and it has to be the phone, jump to section 6. Do not shoot video B on the phone unless the current web frontend has actually landed in the TestFlight build she is holding, and you have confirmed that by watching a deliberately failing publish leave the card on screen.

---

## 1. Pre-flight, in this order

Do not skip ahead. Items 1 to 3 have lead times.

### 1.1 The publish scope is in the OAuth URL

`backend/src/routes/instagram.js` currently requests `instagram_business_basic` and `instagram_business_manage_messages` and nothing else. A token from that list cannot publish. Video B cannot be recorded until `instagram_business_content_publish` is added to that list and deployed.

**Check:** run the rehearsal script (section 2). It reads the `scope` parameter out of the URL that `GET /api/instagram/connect` returns and tells you which scopes are actually being requested.

**If it is missing:** stop. Land the one-line change, deploy, and only then move on. Anything Ellie connects before that deploy has to be reconnected afterwards.

### 1.2 Ellie's Instagram account is an accepted tester on the Meta app

Until the permissions are approved, only Instagram accounts holding a role on the app can authorise it. Invite her account in the Meta app dashboard, then have her accept at Instagram, Settings and privacy, Website permissions, Apps and websites, Tester invites.

**If she has not accepted:** the OAuth screen either refuses her or hands back a token that fails on the first messaging call. Nothing downstream can work around it.

### 1.3 The launch sweep SQL has been run, and Railway restarted

`docs/SQL_2026-08-23_LAUNCH_SWEEP.sql`, top to bottom, in the Supabase SQL editor. Then **restart** the Railway service, not redeploy: PgBouncer caches the schema and a new column stays invisible to the pool until the connection pool is rebuilt.

Two columns in there decide whether a take is possible at all:

- `beauticians.instagram_account_ids`. Without it the webhook matches the delivery on one stored id only. If that id is not the one Meta puts on the delivery, the DM is dropped, logged, and never appears in the Inbox. That has already happened once in production. This is the most likely single cause of "the message just never turned up" on the day.
- `content_posts.media_kind`. The compose form sends it on every draft insert. If the column is absent the insert is rejected outright and "Save as Draft" does nothing at all, with no error on screen.

**Check:** the rehearsal script probes both columns directly and says which are missing.

### 1.4 Ellie reconnects Instagram, once, after 1.1 and 1.3

Settings, the **AI** chip, the **Instagram** card, **Connect**. She signs in to her own Instagram professional account and grants consent.

**Check:** the card should then read `● Connected, @<her handle>`, in green. If it reads `Connected` with no handle after it, the handle lookup failed. If it says `Checking…` for more than a few seconds, the live token check is not answering.

**If the card shows "Needs reconnecting":** the stored token is dead. Tap **Reconnect Instagram** and go round again.

### 1.5 The webhook subscription is on

**Check:** the rehearsal script reads `webhook_subscribed` from `/api/instagram/status`. It must be `true`. `null` means we could not ask, which is not the same as broken, but do not record on a `null`.

**If it is `false`:** the Settings card shows a warning reading "Your account is connected, but Instagram is not sending your DMs here yet." Tap **Reconnect Instagram** on that card. Subscribing is a separate call at connect time and it is deliberately non-fatal, which is why a card can say Connected while no DM will ever arrive.

### 1.6 `instagram_dm_mode` is `off`

Connecting sets it to `'ai'`, which means Florrie answers the reviewer's test DM before Ellie touches the keyboard. That ruins video A.

**Set it:** Settings, **AI** chip, scroll to the card titled **Instagram DMs**. Tap **Store only**.

**The trap:** with `'ai'` stored, the card shows **Redirect to WhatsApp** as the selected option, ticked. Tapping the already-ticked option writes `redirect`, and then the reviewer's DM gets an automatic "message me on WhatsApp instead" reply, on camera. Tap **Store only**, which is the option that is *not* highlighted.

**Check:** reload the page. **Store only** carries the tick and the "Redirect message" editor is gone. Then confirm with the rehearsal script, which reads the stored value from the database rather than from the card.

### 1.7 The `content-images` bucket is public

Instagram fetches the image itself, from the public internet, with none of our session. A private bucket fails at the very last step of video B, several seconds after the tap.

**Check:** the rehearsal script fetches the exact image URL a draft would use, with no credentials, and reports the status and content type.

**If it fails:** in the Supabase SQL editor,
```sql
select id, public from storage.buckets where id = 'content-images';
update storage.buckets set public = true where id = 'content-images';
```
then re-upload the photo (an existing draft's URL keeps working once the bucket flips, but re-uploading removes the doubt), and run the script again.

### 1.8 A draft post is waiting, with a photo

Content tab, **+ New Post**, **Add a photo**, **Feed post**, type a caption, **Save as Draft**. Then check the **Drafts** tab shows it with the photo rendered on the card.

Keep the photo neutral: her own work, no client face, no personal data. Meta reviewers screenshot these.

**If "Save as Draft" appears to do nothing:** that is item 1.3, `media_kind`. Open the browser console and you will see the PostgREST rejection.

### 1.9 A second Instagram account, ready to DM

Not the connected one. A personal or test account, signed in to `https://www.instagram.com` in a **separate browser profile or private window**, so it does not disturb the Florrie session.

It must not have an existing conversation with Ellie's account, so the thread on screen is clean.

### 1.10 The room

- Screen recording at 1080p or better. QuickTime, OBS or Loom.
- Notifications off. Do Not Disturb on. Close Slack, mail, everything with a badge.
- Two browser windows sized so both fit side by side without overlapping, or on two monitors with the recording capturing both.
- Nothing in either window that shows a real client name, phone number, or the Florrie session token.
- Bookmarks bar hidden if it names anything private.
- Do a ten second test recording and play it back. Confirm the text is legible and the cursor is visible.

### 1.11 Final go or no go

Run the rehearsal script one last time, immediately before recording. Every check must pass. It is the only thing standing between you and finding out mid-take.

---

## 2. Run the rehearsal script

```
node docs/meta-review-rehearsal.mjs
```

Run it on the operator's own laptop. It needs the Florrie login for the account being recorded and nothing else: no API keys, no service role, no Meta credentials. Full usage in the header of the file itself.

It prints PASS or FAIL per check in plain English, with what to do about a failure. If anything says FAIL, fix it before you set up the camera. It exits non-zero when anything failed, so it can sit in a checklist script.

What it checks: the API is up and on a build that includes the Instagram hardening; the webhook route is mounted and rejects a wrong verify token; the consent screen asks for all three scopes including the publish one; the account is connected with a live token, a real handle, and the messages webhook subscribed; `instagram_dm_mode` is `off`; the four best-effort columns exist; a draft with a photo is waiting; and the photo can be fetched by an outside party with no credentials. Unless you pass `--no-container` it then creates a real media container against the account, waits for Instagram to report `FINISHED`, and stops without publishing. That last step is the closest thing to a full rehearsal of video B that does not put a post on her profile.

What it cannot check, and you have to check by hand: that Ellie's Instagram account has accepted the app tester invite, that a real inbound DM routes (that needs a real DM), that the redirect URI registered in the Meta dashboard matches ours character for character, and that the device you record on is running a current frontend build. The script prints this list at the end so it does not get forgotten.

One caveat on trust. The script was written against the application source but was never executed against the live services, because the environment it was written in has no network route to Supabase or to the API host. Its logic has been exercised end to end against a local stand-in for both, so the branches and the reporting work; the request shapes are taken from the code they mirror but have not been confirmed against the real endpoints. If a check fails in a way that smells like a bug in the script rather than a real problem, read the raw error it prints and judge it on that rather than cancelling the session.

---

## 3. Video A: `instagram_business_manage_messages`

Target 90 to 110 seconds. **One take. No cuts anywhere.**

### Layout before you press record

- **Left window:** Chrome, signed into `https://florrie.ai` as Ellie, sitting on `/inbox`, on the **Instagram** tab.
- **Right window:** private window at `https://www.instagram.com/direct/inbox/`, signed in as the second account, with a new message to Ellie's handle open and empty.
- Both fully visible. Recording captures both.

### Shots

**Take A1, 0:00 to 0:06, title card.**
Plain background, large text, held still:
> Florrie
> Permission: instagram_business_manage_messages
> A salon owner reads and answers a client's Instagram DM

Hold six seconds. Do not rush this: it is the frame a reviewer reads first.

**Take A2, 0:06 to 0:16, the connection.**
Left window. Navigate to `/settings?section=ai`, or tap **More**, **Settings**, **AI**. Land on the **Instagram** card.
Hold four seconds on the card reading `● Connected, @<handle>`.
Caption overlay: "The salon owner's own Instagram professional account, connected through Instagram Business Login."

**Take A3, 0:16 to 0:26, into the Inbox.**
Click **Inbox** in the bottom navigation. Click the **Instagram** tab at the top of the list.
Hold three seconds on the empty or near-empty list so the reviewer sees the state before the message arrives. This matters: it is what makes the next shot proof rather than assertion.

**Take A4, 0:26 to 0:40, the client sends a DM. DO NOT CUT.**
Move to the right window. Type into Instagram, slowly enough to read:

> Hi! How much is a brow lamination and do you have anything Friday afternoon?

Press send. Hold two seconds on the sent bubble.

The wording is deliberate. It carries booking intent, so Florrie's classifier puts the thread in the **Leads** section rather than the folded-away "Everything else" pile. A message like "love your work!" lands in the quiet pile and you will spend the take hunting for it.

**Take A5, 0:40 to 0:55, it arrives. STILL NO CUT.**
Move back to the left window. Refresh `/inbox` if it has not updated on its own.
The thread appears under **Leads**, in the **Instagram** tab, labelled with the sender's handle.
Hold four seconds on the list with the new row visible.
Caption overlay: "Delivered to our webhook by Meta and verified against the app secret. Nothing has replied to it."

That last sentence earns its place. It tells the reviewer the automated reply is switched off and the human is about to act.

**Take A6, 0:55 to 1:12, Ellie replies.**
Click the thread. The conversation opens with the client's message and an Instagram channel mark beside it.
At the bottom, the channel selector shows a single pill, **Instagram**, already selected. The text box reads "Reply via Instagram…".
Hold two seconds on the composer so the channel pill is legible.
Type, at readable speed:

> Hi! Brow lamination is £45 and I have 2pm free on Friday. Want me to hold it for you?

Click the send arrow. The bubble appears in the thread.
Caption overlay: "POST /me/messages, sent from her own account with her own token, inside Instagram's messaging window."

**Take A7, 1:12 to 1:22, it lands. THIS IS THE SHOT THAT CANNOT BE CUT.**
Move to the right window without stopping the recording. The reply is in the client's Instagram inbox.
**Hold completely still for six seconds.** Do not move the mouse. Do not scroll.

Meta rejects videos where the action and the result are separated by an edit. The whole reason both windows are on one screen is so this transition is a mouse movement, not a cut.

**Take A8, 1:22 to 1:30, outro card.**
> Received via the messages webhook. Replied by the salon owner, from the Inbox.
> Reactive only: we never message anyone who has not messaged her first.

Hold six seconds. Stop recording.

### Captions

Meta reviewers watch muted. Add the caption overlays in post, lower third, white text on a translucent dark bar. Do not re-cut the footage while you do it.

---

## 4. Video B: `instagram_business_content_publish`

Target 80 to 100 seconds. **One take. No cuts anywhere.**

This one publishes for real, to Ellie's real profile. Agree the photo and the caption with her before you record. She can delete the post afterwards; the video stays valid.

### Layout before you press record

- **Left window:** Chrome, signed into `https://florrie.ai` as Ellie, sitting on `/content`, **Drafts** tab, with the pre-staged draft visible.
- **Right window:** `https://www.instagram.com/<her handle>/`, her own profile grid, signed in as her, scrolled to the top.
- Both fully visible.

### Shots

**Take B1, 0:00 to 0:06, title card.**
> Florrie
> Permission: instagram_business_content_publish
> A salon owner publishes a photo of her own work to her own account

**Take B2, 0:06 to 0:14, the profile before.**
Right window. Hold four seconds on her Instagram grid, top row clearly visible.
Caption overlay: "Her profile before publishing."

This is the before frame that makes the after frame mean something. Skip it and the final shot proves nothing.

**Take B3, 0:14 to 0:26, the draft.**
Left window. `/content`, **Drafts** tab.
Hold four seconds on the draft card: photo, caption, hashtags, and the three controls **Approve & Post**, **Edit**, **Discard**.
Caption overlay: "A draft. The photo and caption are hers, reviewed on screen. Nothing has been sent to Instagram."

**Optional, 0:26 to 0:32, the approval step.** Click **Edit**, change one word of the caption, click **Save**. This is worth twelve seconds: it shows the human approval loop that the publish permission depends on. Skip it only if the take is running long.

**Take B4, 0:32 to 0:42, publish. DO NOT CUT FROM HERE TO THE END.**
Click **Approve & Post**.
The button changes to **Posting...**.
**Hold on it.** Publishing is not instant: the backend creates a media container, then polls Instagram until the container reports `FINISHED`, then publishes. Expect anywhere from two to fifteen seconds. Twelve polls at two second intervals is the ceiling before it gives up.
Do not click anything. Do not move the mouse. Let the button sit there.
Caption overlay: "The backend creates a media container, waits for Instagram to finish fetching the image, then calls media_publish."

**Take B5, 0:42 to 0:52, the result in the app.**
The card leaves Drafts. Click the **Posted** tab.
Hold four seconds on the post now listed there, with its photo and caption.
Caption overlay: "Instagram returned a media id. The post is recorded as published."

If the card is still in Drafts, the publish failed. See section 5.

**Take B6, 0:52 to 1:04, the result on Instagram. THE SHOT THAT CANNOT BE CUT.**
Move to the right window. Refresh her profile.
The new post is the first tile in the grid.
**Hold completely still for six seconds.** Then click into the post so the caption is readable, and hold four more.

**Take B7, 1:04 to 1:12, outro card.**
> Drafted in Florrie, approved by the salon owner, published to her own account.
> Nothing publishes without an explicit approval of that specific post.

Hold six seconds. Stop recording.

---

## 5. When a step fails mid-take

The rule, before anything else: **stop recording, fix the problem, start again from the title card.** Never splice two takes together. A visible edit between an action and its result is one of the most reliable rejection reasons there is, and it costs a week each time.

Below is what each failure actually means, so you know whether you are three minutes or three days from another attempt.

### Video A

**The DM never appears in the Inbox.**
Check the Instagram tab, then the **Everything else** section, which is folded away behind a count. A message with no booking intent lands there rather than in Leads. If it is in neither, the delivery was dropped: the API log will carry "no beautician matches any id on this delivery" together with the ids Meta sent. That is `instagram_account_ids` (pre-flight 1.3). Not fixable in the room. Run the SQL, restart Railway, reconnect, try again.

**An automatic reply goes out before Ellie types anything.**
`instagram_dm_mode` is `ai` or `redirect`. Pre-flight 1.6. Set it to **Store only**, wait for the seven day per-client suppression not to matter (it only applies to redirect mode, and only per client), and use a *different* second Instagram account for the retake so the thread is clean.

**The send fails with an Instagram error under the composer.**
Almost always the token or the tester role. Open the Settings, AI, Instagram card: if it says "Needs reconnecting", reconnect and start over. If the card is green and the send still fails, it is the app role or a missing scope, and that is pre-flight 1.1 and 1.2, not a same-day fix.

**The thread is titled "Instagram User" with no handle.**
The identity lookup failed, usually because the token cannot read the sender's profile. Not fatal to the take, but ugly. It self-heals on the sender's next message once the token is good, so send a second DM and refresh before you re-record.

**The composer shows no Instagram pill, or shows several.**
Several pills mean Florrie matched this person to an existing client record that has a phone or an email. Use a second Instagram account that has never been a client.

### Video B

**"Save as Draft" does nothing.**
`content_posts.media_kind` is missing. Pre-flight 1.3. The browser console shows the PostgREST rejection. Not fixable in the room.

**The draft card stays in Drafts and a red message appears.**
Read it: that is the reason Instagram gave, passed straight through. The common ones:

- *"The photo link is a private, signed link that expires"* or *"The photo is on an address only this server can reach"*: the image URL is wrong at the source. Pre-flight 1.7.
- *"Instagram is still processing the photo"*: the container never reached `FINISHED` within twenty four seconds. Usually a large image or a slow fetch. Re-upload a smaller JPEG, under 8 MB, at a standard aspect ratio, and try again.
- *"Instagram could not process the photo (ERROR)"*: Meta fetched the URL and did not like what came back. Check the URL opens in a private browser window and returns an actual image, not an HTML error page.
- A permissions error naming the publish scope: pre-flight 1.1. Stop.

**The card disappears but nothing is on the profile.**
You are recording on the old iOS bundle. Section 0. Move to the browser.

**The publish is still spinning after twenty five seconds.**
It has timed out and will report a failure imminently. Let it finish rather than clicking again: a second click starts a second container against the same draft. Stop the recording, read the error, fix, restart.

### Both videos

**Anything at all appears on screen that should not: a client's name, a phone number, a notification banner.**
Stop. Start over. Do not attempt to blur it in post, because blurring requires re-encoding and reviewers read a doctored frame as a doctored video.

---

## 6. Phone fallback, if a desktop recording is impossible

Only for video A, and only having read section 0.

One iPhone, iOS screen recording, both apps on it:

- Instagram app with the second account added through the account switcher, so both accounts are on one device.
- Florrie from TestFlight, signed in as Ellie.

Run the same beats as section 3, using the iOS app switcher instead of moving between windows. App switching inside one continuous screen recording is fine and is not a cut.

Two warnings.

The Settings Instagram card on the TestFlight build may not show `● Connected, @handle` or the reconnect and webhook prompts, because those are new frontend that only reaches the phone after an Xcode Cloud build lands and she updates TestFlight. If the card looks different from section 3's take A2, shoot take A2 in a mobile browser at `florrie.ai` instead, still in the same recording.

Before you record, switch the Instagram app to the second account and check that the account switcher does not flash the account list on screen mid-take. Rehearse the switch twice.

Video B stays on the desktop regardless. The publish failure handling is exactly the frontend fix that the phone does not have yet, and the failure mode is a take that looks like a success.

---

## 7. Export and upload

- MP4, H.264. 1080p if the file stays under 50 MB, otherwise 720p30.
- Under 50 MB per file. Some browsers refuse larger uploads to the review form.
- Captions burned in, lower third, white on translucent dark.
- No music. No voiceover unless Meta specifically asks for one.
- Filenames: `florrie_instagram_business_manage_messages.mp4` and `florrie_instagram_business_content_publish.mp4`.
- Upload one video against each permission in the App Review form. Do not attach the same file to both.

## 8. After recording, before submitting

- Watch both videos end to end, muted, at full size. If you cannot follow what is happening with the sound off, a reviewer cannot either.
- Confirm no cut exists between an action and its result. Scrub the two moments named in sections 3 and 4 specifically.
- Check no frame contains a real client's name, a phone number, an email address, or a token.
- Delete the test post from Ellie's Instagram if she wants it gone. The video stays valid.
- Delete the test conversation from the second Instagram account only after both videos are accepted, in case a reviewer asks a follow-up.
