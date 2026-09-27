BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

-- New, service-only tables. Existing bookings and customer connections are untouched.
CREATE TABLE IF NOT EXISTS public.google_review_connections (
  beautician_id uuid PRIMARY KEY REFERENCES public.beauticians(id) ON DELETE CASCADE,
  tokens text,
  location_name text,
  location_title text,
  oauth_nonce text,
  oauth_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.content_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  beautician_id uuid NOT NULL REFERENCES public.beauticians(id) ON DELETE CASCADE,
  post_id uuid UNIQUE REFERENCES public.content_posts(id) ON DELETE SET NULL,
  token text NOT NULL UNIQUE DEFAULT replace(gen_random_uuid()::text, '-', ''),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS content_campaigns_owner ON public.content_campaigns(beautician_id);
CREATE TABLE IF NOT EXISTS public.content_booking_sources (
  appointment_id uuid PRIMARY KEY REFERENCES public.appointments(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES public.content_campaigns(id) ON DELETE CASCADE,
  beautician_id uuid NOT NULL REFERENCES public.beauticians(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS content_booking_sources_campaign ON public.content_booking_sources(campaign_id);
CREATE TABLE IF NOT EXISTS public.review_post_permissions (
  post_id uuid PRIMARY KEY REFERENCES public.content_posts(id) ON DELETE CASCADE,
  review_id uuid REFERENCES public.reviews(id) ON DELETE SET NULL,
  beautician_id uuid NOT NULL REFERENCES public.beauticians(id) ON DELETE CASCADE,
  approved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(beautician_id, review_id)
);
ALTER TABLE public.google_review_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_booking_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_post_permissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.google_review_connections, public.content_campaigns, public.content_booking_sources, public.review_post_permissions FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.google_review_connections, public.content_campaigns, public.content_booking_sources, public.review_post_permissions TO service_role;

CREATE OR REPLACE FUNCTION public.record_content_booking(p_owner uuid, p_appointment uuid, p_token text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE matched uuid;
BEGIN
  SELECT c.id INTO matched FROM content_campaigns c
  JOIN content_posts p ON p.id=c.post_id AND p.beautician_id=c.beautician_id
  WHERE c.beautician_id=p_owner AND c.token=p_token AND p.post_type IS DISTINCT FROM 'gallery';
  IF matched IS NULL THEN RETURN false; END IF;
  INSERT INTO content_booking_sources(appointment_id,campaign_id,beautician_id)
  SELECT a.id,matched,p_owner FROM appointments a WHERE a.id=p_appointment AND a.beautician_id=p_owner
  ON CONFLICT (appointment_id) DO NOTHING;
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.content_booking_results(p_owner uuid)
RETURNS TABLE(campaign_id uuid,post_id uuid,caption text,token text,confirmed bigint,pending bigint,cancelled bigint,booking_value_cents bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id,c.post_id,left(p.caption,160),c.token,
    count(a.id) FILTER (WHERE a.status IN ('confirmed','in_progress','completed')),
    count(a.id) FILTER (WHERE a.status='pending'),
    count(a.id) FILTER (WHERE a.status IN ('cancelled_by_client','cancelled_by_beautician','no_show','rescheduled')),
    coalesce(sum(a.price_cents) FILTER (WHERE a.status IN ('confirmed','in_progress','completed')),0)::bigint
  FROM content_campaigns c
  LEFT JOIN content_posts p ON p.id=c.post_id AND p.beautician_id=p_owner
  LEFT JOIN content_booking_sources s ON s.campaign_id=c.id AND s.beautician_id=p_owner
  LEFT JOIN appointments a ON a.id=s.appointment_id AND a.beautician_id=p_owner
    AND a.created_at>=now()-interval '90 days'
  WHERE c.beautician_id=p_owner
  GROUP BY c.id,c.post_id,p.caption,c.token ORDER BY c.created_at DESC;
$$;

CREATE OR REPLACE FUNCTION public.create_review_post(p_owner uuid,p_review uuid,p_expected text)
RETURNS SETOF public.content_posts LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.reviews; existing uuid; created uuid;
BEGIN
  SELECT * INTO r FROM reviews WHERE id=p_review AND beautician_id=p_owner FOR UPDATE;
  IF NOT FOUND OR r.is_public IS DISTINCT FROM true OR r.platform='google' OR nullif(trim(r.comment),'') IS NULL THEN
    RAISE EXCEPTION 'This feedback is not available for a post' USING ERRCODE='22023';
  END IF;
  IF r.comment IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'The feedback changed. Review it again before sharing' USING ERRCODE='22023';
  END IF;
  SELECT post_id INTO existing FROM review_post_permissions WHERE review_id=p_review AND beautician_id=p_owner;
  IF existing IS NOT NULL THEN RETURN QUERY SELECT * FROM content_posts WHERE id=existing AND beautician_id=p_owner; RETURN; END IF;
  INSERT INTO content_posts(beautician_id,caption,platform,post_type,status)
  VALUES(p_owner,'“'||r.comment||'”'||E'\n\nThank you for sharing your experience.','instagram','testimonial','draft') RETURNING id INTO created;
  INSERT INTO review_post_permissions(post_id,review_id,beautician_id) VALUES(created,p_review,p_owner);
  RETURN QUERY SELECT * FROM content_posts WHERE id=created AND beautician_id=p_owner;
END $$;
REVOKE ALL ON FUNCTION public.record_content_booking(uuid,uuid,text), public.content_booking_results(uuid), public.create_review_post(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_content_booking(uuid,uuid,text), public.content_booking_results(uuid), public.create_review_post(uuid,uuid,text) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
