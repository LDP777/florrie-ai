# Privacy disclosures and optional analytics

The previous notice omitted Instagram, Anthropic AI processing, voice, consultation health answers and personalised writing records. It also claimed no sharing with third parties and guaranteed provider revocation and backup erasure on unverified deadlines. The separate deletion page contradicted the existing pending/review workflow.

The pages now describe the implemented features, service providers, salon/client roles, saved writing examples, connection removal versus data erasure, and verified completion versus pending cleanup. The public consultation notice no longer claims that only the salon can see data which Florrie processes for it. Existing routes, forms, signatures, consent controls and account-deletion actions are unchanged.

Optional product analytics are disabled. The compatibility exports do not load PostHog, subscribe to auth, capture identifiers or URLs, use storage, or record sessions. The explicit PostHog vendor chunk is removed. Error reporting remains enabled where configured and deferred until after paint. There are no feature-flag call sites outside the analytics module, so the existing false/null defaults do not disable app features. The privacy page does not claim that server error reporting has stopped.

## Validation

The full project build, including 79 frontend render checks, passed. The existing deferred-reporting browser check verified that Sentry still loads and no PostHog vendor chunk is emitted. Analytics calls were exercised with failing network/storage accessors and remained inert, with false/null feature defaults. No backend, billing, auth, diary, or channel settings changed in this module.

The checked local production configuration and locally bundled iPhone assets contained no PostHog project key. This is evidence about those files only; it is not proof of all historic production builds or that no data ever reached PostHog. Existing TestFlight installs do not receive new bundled code until updated.

## Remaining launch work

This corrects factual disclosures; it does not certify legal compliance. Verify the current processor agreements, transfer locations/safeguards, retention periods for provider records/backups, the salon processing agreement, and the health-data permission flow with the company’s privacy adviser. Record the actual arrangements before adding specific guarantees. Do not mark Meta data-handling attestations complete based only on this copy change.

Check any historic PostHog project for retained data if a key was previously enabled. Keep analytics disabled until a separate reviewed consent/choice mechanism and restricted event schema exist. Session recordings of client and consultation screens should not be introduced by enabling an environment key.

References checked 15 September 2026:
- [ICO: privacy information](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/the-right-to-be-informed/what-privacy-information-should-we-provide/)
- [ICO: erasure and response periods](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-erasure/)
- [ICO: storage and access technologies](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/what-are-storage-and-access-technologies/)
