-- Additive only: no changes to authentication, bookings or message delivery.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
CREATE TABLE IF NOT EXISTS public.knowledge_suggestions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 beautician_id uuid NOT NULL REFERENCES public.beauticians(id) ON DELETE CASCADE,
 source_message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','pending','approved','dismissed','not_reusable','retry')),
 category text,
 title text,
 content text,
 evidence text,
 knowledge_entry_id uuid REFERENCES public.knowledge_entries(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (beautician_id,source_message_id)
);
CREATE INDEX IF NOT EXISTS knowledge_suggestions_owner_status ON public.knowledge_suggestions(beautician_id,status,created_at DESC);
ALTER TABLE public.knowledge_suggestions ENABLE ROW LEVEL SECURITY;
-- Suggestions contain private source links. Only the authenticated API reads
-- them; an anon/authenticated database client cannot approve its own AI draft.
REVOKE ALL ON public.knowledge_suggestions FROM anon,authenticated;
GRANT ALL ON public.knowledge_suggestions TO service_role;

CREATE OR REPLACE FUNCTION public.approve_knowledge_suggestion(
 p_owner uuid,p_id uuid,p_category text,p_title text,p_content text,p_replace uuid DEFAULT NULL
) RETURNS SETOF public.knowledge_entries
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE suggestion public.knowledge_suggestions; entry_id uuid;
BEGIN
 SELECT * INTO suggestion FROM public.knowledge_suggestions WHERE id=p_id AND beautician_id=p_owner FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Suggestion not found' USING ERRCODE='P0002'; END IF;
 IF suggestion.status='approved' THEN
  RETURN QUERY SELECT * FROM public.knowledge_entries WHERE id=suggestion.knowledge_entry_id AND beautician_id=p_owner;
  RETURN;
 END IF;
 IF suggestion.status <> 'pending' THEN RAISE EXCEPTION 'Suggestion is not awaiting approval' USING ERRCODE='22023'; END IF;
 IF length(trim(p_title)) NOT BETWEEN 1 AND 120 OR length(trim(p_content)) NOT BETWEEN 1 AND 5000 THEN
  RAISE EXCEPTION 'Invalid guidance' USING ERRCODE='22023';
 END IF;
 IF p_replace IS NOT NULL THEN
  UPDATE public.knowledge_entries SET title=trim(p_title),content=trim(p_content),category=p_category,updated_at=now()
  WHERE id=p_replace AND beautician_id=p_owner RETURNING id INTO entry_id;
  IF entry_id IS NULL THEN RAISE EXCEPTION 'Answer not found' USING ERRCODE='P0002'; END IF;
 ELSE
  INSERT INTO public.knowledge_entries(beautician_id,category,title,content)
  VALUES(p_owner,p_category,trim(p_title),trim(p_content)) RETURNING id INTO entry_id;
 END IF;
 UPDATE public.knowledge_suggestions SET status='approved',knowledge_entry_id=entry_id,updated_at=now() WHERE id=p_id;
 RETURN QUERY SELECT * FROM public.knowledge_entries WHERE id=entry_id AND beautician_id=p_owner;
END $$;
REVOKE ALL ON FUNCTION public.approve_knowledge_suggestion(uuid,uuid,text,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.approve_knowledge_suggestion(uuid,uuid,text,text,text,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
