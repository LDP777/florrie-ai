# Content v2

The new Content screen prepares posts from the salon's diary, permitted photos, approved offers and shareable reviews. The owner checks one post at a time. Approval covers the words, image, link, destination and format. A material change requires a fresh approval; moving the time keeps approval.

The supplied Content v2 brief is the product specification. The implementation keeps the existing fonts, colours, `/content` route, booking availability engine and tracked booking links. The old Content page remains available for salons whose flag is off. Existing posts, photo rows, content streams and team runs remain in the database.

## Review and verification

See [verification and screenshots](verification.md) for the completed checks and the remaining real iPhone checks.

The review journey has one primary action on home: Check posts. The deck keeps Approve visible above the phone home indicator. Revision chips change the requested part; history supports Undo. The shell privacy control hides post details and closes the deck. Saved preparation steps and an idempotency key allow a job to resume after interruption.

Automated checks use fictional salons and intercepted browser requests. They make no provider posts, send no client messages and change no live bookings.

Commands from the repository root:

```sh
npm install
node scripts/check-lockfile.mjs
npm test --workspace backend
VITE_SUPABASE_URL=https://placeholder.supabase.co VITE_SUPABASE_ANON_KEY=placeholder VITE_API_URL=https://api.florrie.ai npm run build --workspace frontend
node frontend/scripts/check-content-v2.mjs
node frontend/scripts/check-content-artwork.mjs
node --test frontend/src/lib/content-share.test.mjs
```

The browser check runs Chromium and WebKit at four phone sizes by default and saves the requested states when `VISUAL_OUTPUT_DIR` is set. Set `CONTENT_V2_BROWSER=chromium` or `CONTENT_V2_BROWSER=webkit` for a focused rerun. The test serves the bundled fonts and blocks external browser traffic. `CONTENT_V2_REFERENCE` can point to the supplied fictional photo directory; `CONTENT_V2_ARTWORK` can point to generated `before_after.jpg` and `offer.jpg` fixtures. CI uses the included synthetic image fallback. The bundled reference preview and its fake provider are outside the application and outside this PR.

## Migration and staged rollout

1. Back up and apply `supabase/migrations/20261123090000_content_v2.sql` with the existing migration runner. Keep its filename after applying it.
2. Restart the Railway backend after the migration so cached prepared statements use the new columns. The migration asks PostgREST to reload its schema.
3. Deploy the branch to a test environment. Enable only a fictional test salon:

   ```sql
   update public.beauticians set content_v2 = true where id = '<test salon UUID>';
   ```

4. Check the web journey, then archive the branch for iPhone testing. Capacitor bundles the frontend, so the existing TestFlight build cannot show these changes.
5. Verify safe areas, app close/reopen, connection handoff and Save Image on a real iPhone in Safari and the new native build. Enable the pilot salon only after those checks.
6. Keep `ContentAutopilot.jsx` until real iPhone verification. Remove it and its obsolete checks in a separate PR.

Disable a salon's `content_v2` flag to return to the old interface. Do not drop the additive tables or columns. In-flight provider requests still need reconciliation before any manual retry.

## Publishing and data

`content_preparations` and `content_voice_rules` use RLS with service-role access only. Backend queries scope records to the authenticated salon. Caption autosave uses a version comparison; approval compares the material hash. The worker rechecks prices, booking availability, offers, review permission and photo consent before dispatch.

An uncertain provider response keeps its publishing claim. The reconciler reads the provider before permitting another attempt. Provider IDs or an explicit owner confirmation determine the Posted state. Reel plans have no video and cannot be published.

Results count confirmed bookings through a post's tracked link and display pending and cancelled bookings separately. A possible connection to a booking without that link appears under Not measured. Booking value is not money collected.

## External dependencies

- Instagram publishing requires a valid salon connection and Meta access for `instagram_business_content_publish`. Check Advanced Access before allowing anyone outside the Meta app's roles.
- Google publishing stays off unless `GOOGLE_POSTS_ENABLED=true`; it requires the salon's `business.manage` connection and approved API access. Its connection state is separate from Instagram.
- `ANTHROPIC_API_KEY` enables model writing and free-text revisions. Deterministic templates and quick revisions work without it. No new variable is required for API startup.
- Instagram captions cannot provide clickable links, change the bio link or add Story link stickers. Attribution comes through Google Book buttons, Florrie's replies and links the owner shares.
- Share and Filesystem plugins provide the native Save Image handoff. The native privacy manifest declares file timestamp access for the app's cache.
- The artwork renderer bundles licensed Playfair Display and Plus Jakarta Sans fonts. It emits JPEG files for Instagram.

No migration, production flag change, merge, live post or client message forms part of this branch build.
