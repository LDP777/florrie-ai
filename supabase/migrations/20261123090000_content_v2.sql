BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.beauticians ADD COLUMN IF NOT EXISTS content_v2 boolean NOT NULL DEFAULT false;
ALTER TABLE public.content_posts DROP CONSTRAINT IF EXISTS content_posts_platform_check;
ALTER TABLE public.content_posts ADD CONSTRAINT content_posts_platform_check CHECK (platform IN ('instagram','facebook','tiktok','google'));
ALTER TABLE public.content_posts
  ADD COLUMN IF NOT EXISTS kind text DEFAULT 'post' CHECK (kind IN ('post','reel_plan')),
  ADD COLUMN IF NOT EXISTS purpose jsonb,
  ADD COLUMN IF NOT EXISTS claims jsonb DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS facts jsonb DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS change_note jsonb,
  ADD COLUMN IF NOT EXISTS alternatives jsonb DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS media jsonb,
  ADD COLUMN IF NOT EXISTS prepared_caption text,
  ADD COLUMN IF NOT EXISTS prepared_hashtags text[],
  ADD COLUMN IF NOT EXISTS edited_by_owner boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS history jsonb DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS material_hash text,
  ADD COLUMN IF NOT EXISTS approved_hash text,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS timing_reason text,
  ADD COLUMN IF NOT EXISTS held boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS publish_key text,
  ADD COLUMN IF NOT EXISTS publish_attempts integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS publish_uncertain_since timestamptz,
  ADD COLUMN IF NOT EXISTS published_by_owner boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS preparation_id uuid,
  ADD COLUMN IF NOT EXISTS reel jsonb,
  ADD COLUMN IF NOT EXISTS treatment_id uuid REFERENCES public.treatments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS consent_id uuid REFERENCES public.photo_consents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS permission_status text CHECK (permission_status IN ('granted','no_client','pending','withdrawn')),
  ADD COLUMN IF NOT EXISTS link_url text,
  ADD COLUMN IF NOT EXISTS format text DEFAULT 'feed',
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_revision jsonb;

CREATE TABLE IF NOT EXISTS public.content_preparations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  beautician_id uuid NOT NULL REFERENCES public.beauticians(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  request jsonb NOT NULL,
  label text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  step integer NOT NULL DEFAULT 0 CHECK (step BETWEEN 0 AND 5),
  details jsonb NOT NULL DEFAULT '{}',
  post_ids uuid[] NOT NULL DEFAULT '{}',
  notes text[] NOT NULL DEFAULT '{}',
  attempts integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  lease_token uuid,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (beautician_id, request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS content_preparations_one_running
  ON public.content_preparations(beautician_id) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS content_preparations_worker ON public.content_preparations(status,lease_until);
CREATE TABLE IF NOT EXISTS public.content_voice_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  beautician_id uuid NOT NULL REFERENCES public.beauticians(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('replace','no_exclaim','sign_off','max_hashtags')),
  from_text text,
  to_text text,
  value text,
  source_post_id uuid REFERENCES public.content_posts(id) ON DELETE SET NULL,
  learned_at timestamptz NOT NULL DEFAULT now(),
  forgotten_at timestamptz
);
CREATE INDEX IF NOT EXISTS content_voice_rules_owner ON public.content_voice_rules(beautician_id) WHERE forgotten_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS content_voice_rules_active_unique ON public.content_voice_rules
  (beautician_id,kind,coalesce(from_text,''),coalesce(to_text,''),coalesce(value,'')) WHERE forgotten_at IS NULL;
ALTER TABLE public.content_preparations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_voice_rules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.content_preparations, public.content_voice_rules FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.content_preparations, public.content_voice_rules TO service_role;

ALTER TABLE public.promo_codes
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS treatment_ids uuid[],
  ADD COLUMN IF NOT EXISTS appointments_from date,
  ADD COLUMN IF NOT EXISTS appointments_to date,
  ADD COLUMN IF NOT EXISTS terms text,
  ADD COLUMN IF NOT EXISTS marketing_approved_at timestamptz;

-- Match state.js: PostgreSQL jsonb text has canonical key order and spacing.
CREATE OR REPLACE FUNCTION public.content_v2_material_hash(p public.content_posts)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT md5(jsonb_build_array(coalesce(p.caption,''),coalesce(to_jsonb(p.hashtags),'[]'),
    p.media,coalesce(p.image_url,''),coalesce(p.link_url,''),coalesce(p.platform,'instagram'),
    coalesce(p.format,p.media_kind,'feed'))::text);
$$;
REVOKE ALL ON FUNCTION public.content_v2_material_hash(public.content_posts) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.content_v2_material_hash(public.content_posts) TO service_role;

UPDATE public.content_posts SET format=coalesce(media_kind,'feed'), prepared_caption=caption
  WHERE prepared_caption IS NULL;
UPDATE public.content_posts SET prepared_hashtags=coalesce(hashtags,'{}') WHERE prepared_hashtags IS NULL;
UPDATE public.content_posts p SET permission_status=CASE
  WHEN c.revoked_at IS NOT NULL OR c.status IN ('declined','expired') OR c.expires_at<=now() THEN 'withdrawn'
  WHEN c.status='granted' AND 'instagram'=ANY(c.permitted_uses) THEN 'granted'
  ELSE 'pending' END
FROM public.photo_consents c WHERE p.post_type='gallery' AND p.consent_id=c.id AND p.beautician_id=c.beautician_id;
UPDATE public.content_posts SET permission_status='pending' WHERE post_type='gallery' AND permission_status IS NULL;
UPDATE public.content_posts p SET claims=jsonb_build_array(jsonb_build_object('kind','quote','review_id',r.id,'text',r.comment))
  FROM public.review_post_permissions permission, public.reviews r
  WHERE permission.post_id=p.id AND permission.beautician_id=p.beautician_id AND r.id=permission.review_id AND r.beautician_id=p.beautician_id
    AND p.post_type='testimonial' AND p.caption LIKE '%'||r.comment||'%' AND p.claims='[]'::jsonb;
INSERT INTO public.content_campaigns(beautician_id,post_id)
  SELECT beautician_id,id FROM public.content_posts WHERE post_type IS DISTINCT FROM 'gallery'
  ON CONFLICT(post_id) DO NOTHING;
UPDATE public.content_posts p SET link_url='https://florrie.ai/book/'||b.booking_slug||'?fl_content='||c.token
  FROM public.content_campaigns c, public.beauticians b
  WHERE c.post_id=p.id AND c.beautician_id=p.beautician_id AND b.id=p.beautician_id
    AND p.link_url IS NULL AND b.booking_slug ~ '^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$';
UPDATE public.content_posts p SET material_hash=public.content_v2_material_hash(p) WHERE material_hash IS NULL;
UPDATE public.content_posts SET approved_hash=material_hash
  WHERE status IN ('approved','scheduled') AND approved_hash IS NULL;
CREATE INDEX IF NOT EXISTS content_posts_preparation ON public.content_posts(preparation_id) WHERE preparation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS content_posts_v2_open ON public.content_posts(beautician_id,status,scheduled_for) WHERE deleted_at IS NULL;

NOTIFY pgrst, 'reload schema';
COMMIT;
