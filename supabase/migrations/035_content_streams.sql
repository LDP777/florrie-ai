-- Content streams table — support multiple Instagram streams per beautician
-- e.g. personal content + sponsored brand streams (BuffBrows, etc.)
CREATE TABLE IF NOT EXISTS content_streams (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('personal', 'sponsor', 'campaign')),
  monthly_target INTEGER, -- null for personal (unlimited), e.g. 8 for BuffBrows
  brand_notes JSONB DEFAULT '{}', -- tone, hashtags, dos/donts, product mentions
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add stream_id to content_posts
ALTER TABLE content_posts
  ADD COLUMN IF NOT EXISTS stream_id UUID REFERENCES content_streams(id) ON DELETE SET NULL;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_content_streams_beautician ON content_streams(beautician_id);
CREATE INDEX IF NOT EXISTS idx_content_posts_stream ON content_posts(stream_id);

-- RLS — beauticians can only manage their own streams
ALTER TABLE content_streams ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Beauticians can manage their streams"
  ON content_streams FOR ALL
  USING (beautician_id = auth.uid());

-- Grant access to authenticated users
GRANT SELECT, INSERT, UPDATE, DELETE ON content_streams TO authenticated;
