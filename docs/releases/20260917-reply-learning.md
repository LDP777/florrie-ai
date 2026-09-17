# Learning from owner replies

An owner-written or edited Inbox reply can produce a draft answer for future clients. Suggestions are kept apart from `knowledge_entries` and cannot inform a reply until the owner approves them. Manual delivery completes independently of extraction. No client messages are sent by the learning process.

In a chat, **Teach Florrie** opens a review of that sent reply. **Florrie’s knowledge → Check my recent replies** checks up to six unprocessed replies from the latest thirty owner replies in the last thirty days. This also recovers work missed during a service interruption. The owner can edit, approve, update an existing answer, or keep a suggestion in its conversation. Updating a paused answer preserves the pause.

The extractor can classify and title guidance, but the proposed answer retains the complete owner-written reply apart from a greeting. This preserves conditions the model might omit. Personal exceptions, identifiable details, individual eligibility and appointment confirmations are excluded where detected; review remains required. Untouched AI replies, client messages, failed deliveries and unverified authorship are not training sources. Edited Outbox drafts still lack reliable edit provenance and are not automatically learned from.

Approved answers use the existing question-answer pipeline. That pipeline can now consider up to twelve complete approved notes within 12,000 characters even without a keyword match, and must cite supporting evidence. Other reply paths keep their existing retrieval behaviour. This is approved salon knowledge, not model fine-tuning or an assurance that every question can be answered.

## Release order

1. Apply `supabase/migrations/20260917_reply_learning.sql` to the target Supabase database. It adds a private suggestions table and an approval function restricted to the existing server role. Approval and note creation/update happen in one transaction. The migration reloads PostgREST's schema.
2. Verify the table and function are available before deploying the app. No booking, authentication, subscription or AI-consent setting changes are part of this release.
3. Run backend tests with `TZ=UTC`, the workspace build and `frontend/scripts/check-knowledge-training.mjs`.
4. Deploy, then check normal demo sign-in and the learning/knowledge endpoints. Use fictional data for write/preview proofs. Do not send clients test messages or approve inferred rules for Ellie.

The real-provider proof uses fictional voucher and treatment rules. It checks extraction, retained qualifications, rejection of personal examples and an answer before teaching, after approval and after pausing. It does not measure a production reduction in handoffs to Ellie.
