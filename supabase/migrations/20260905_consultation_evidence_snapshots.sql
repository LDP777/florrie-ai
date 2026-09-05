-- Run before the consultation care release. No client answers are reconstructed.
BEGIN;
-- Prevent inserts/edits between backfill and trigger installation.
LOCK TABLE consultation_forms, consultation_form_fields, consultation_responses IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE consultation_responses ADD COLUMN IF NOT EXISTS form_snapshot jsonb;

CREATE OR REPLACE FUNCTION consultation_form_snapshot(p_form_id uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SET search_path = public AS $$
  SELECT jsonb_build_object('name', f.name, 'consent_text', f.consent_text,
    'consultation_form_fields', COALESCE((SELECT jsonb_agg(to_jsonb(q) ORDER BY q.sort_order)
      FROM consultation_form_fields q WHERE q.form_id = f.id), '[]'::jsonb))
  FROM consultation_forms f WHERE f.id = p_form_id;
$$;

UPDATE consultation_responses SET form_snapshot = consultation_form_snapshot(form_id)
WHERE form_snapshot IS NULL;

CREATE OR REPLACE FUNCTION capture_consultation_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- A response's evidence must not change after issue, including on submission.
    NEW.form_snapshot := OLD.form_snapshot;
    NEW.form_id := OLD.form_id;
  ELSE
    -- Serialize issuance against the transactional template editor below.
    PERFORM id FROM consultation_forms WHERE id = NEW.form_id FOR SHARE;
    NEW.form_snapshot := consultation_form_snapshot(NEW.form_id);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS consultation_response_snapshot ON consultation_responses;
CREATE TRIGGER consultation_response_snapshot BEFORE INSERT OR UPDATE ON consultation_responses
FOR EACH ROW EXECUTE FUNCTION capture_consultation_snapshot();

-- One transaction: clients cannot receive half an edited template.
CREATE OR REPLACE FUNCTION save_consultation_template(p_owner uuid, p_id uuid, p_form jsonb)
RETURNS uuid LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_id uuid; field jsonb; current_form jsonb;
BEGIN
  IF p_id IS NULL THEN
    INSERT INTO consultation_forms (beautician_id, name, consent_text, is_default)
    VALUES (p_owner, p_form->>'name', p_form->>'consent_text', false) RETURNING id INTO v_id;
  ELSE
    SELECT id INTO v_id FROM consultation_forms WHERE id = p_id AND beautician_id = p_owner FOR UPDATE;
    IF v_id IS NULL THEN RAISE EXCEPTION 'Form not found'; END IF;
    SELECT jsonb_build_object('name', f.name, 'consent_text', f.consent_text, 'is_default', f.is_default,
      'fields', COALESCE((SELECT jsonb_agg(to_jsonb(q) ORDER BY q.sort_order) FROM consultation_form_fields q WHERE q.form_id = f.id), '[]'::jsonb))
      INTO current_form FROM consultation_forms f WHERE f.id = v_id;
    p_form := current_form || p_form;

  END IF;
  IF COALESCE((p_form->>'is_default')::boolean, false) THEN
    UPDATE consultation_forms SET is_default = false WHERE beautician_id = p_owner AND id <> v_id AND is_default;
  END IF;
  UPDATE consultation_forms SET name = p_form->>'name', consent_text = p_form->>'consent_text',
    is_default = COALESCE((p_form->>'is_default')::boolean, false), updated_at = now() WHERE id = v_id;
  DELETE FROM consultation_form_fields WHERE form_id = v_id;
  FOR field IN SELECT * FROM jsonb_array_elements(COALESCE(p_form->'fields', '[]'::jsonb)) LOOP
    INSERT INTO consultation_form_fields (form_id, type, label, options, required, sort_order)
    VALUES (v_id, field->>'type', field->>'label', COALESCE(field->'options','[]'::jsonb),
      COALESCE((field->>'required')::boolean,false), COALESCE((field->>'sort_order')::integer,0));
  END LOOP;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION save_consultation_template(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION save_consultation_template(uuid, uuid, jsonb) TO service_role;
COMMIT;
