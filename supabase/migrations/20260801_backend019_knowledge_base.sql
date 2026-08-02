-- 019: the knowledge base.
-- Ellie's own notes (aftercare sheets, policies, treatment explainers, prep
-- instructions) become something Florrie can quote instead of guessing or
-- escalating. One table, plain text, owned by the beautician.
--
-- Retrieval is deliberately lexical (keyword overlap, see lib/knowledge.js):
-- one salon's base is dozens of entries, not millions, and there is no
-- embeddings API available. If we ever want vectors, add an "embedding"
-- column here later; the schema needs nothing else changed for that.
--
-- Run by hand in the Supabase SQL editor (idempotent, safe to re-run).
-- After running, RESTART Railway so PgBouncer's schema cache sees the table.

CREATE TABLE IF NOT EXISTS knowledge_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('aftercare','policy','treatment','prep','faq','general')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Retrieval always filters "active entries for this beautician", so a partial
-- index on exactly that shape keeps it one cheap lookup.
CREATE INDEX IF NOT EXISTS idx_knowledge_beautician
  ON knowledge_entries (beautician_id) WHERE is_active;

-- RLS: the backend uses the service key (bypasses RLS); the owner policy is
-- belt and braces so the anon key can never read another salon's notes.
ALTER TABLE knowledge_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS knowledge_entries_owner ON knowledge_entries;
CREATE POLICY knowledge_entries_owner ON knowledge_entries
  FOR ALL USING (beautician_id = auth.uid());

COMMENT ON TABLE knowledge_entries IS
  'The salon''s own notes: aftercare, policies, treatment info, prep. Florrie answers client questions ONLY from these, never from guesswork.';
