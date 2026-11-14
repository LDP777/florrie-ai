-- Read-only. Run before the migration; the first result must contain no rows.
WITH required(table_name,column_name,expected_type) AS (VALUES
 ('appointments','id','uuid'),('appointments','beautician_id','uuid'),('appointments','client_id','uuid'),
 ('appointments','management_token','uuid'),('appointments','starts_at','timestamp with time zone'),
 ('appointments','price_cents','integer'),('appointments','policy_snapshot','jsonb'),
 ('appointments','status','text'),('appointments','cancelled_at','timestamp with time zone'),
 ('appointments','late_cancel_charged','boolean'),
 ('ai_actions','id','uuid'),('ai_actions','beautician_id','uuid'),('ai_actions','client_id','uuid'),
 ('ai_actions','appointment_id','uuid'),('ai_actions','action_type','text'),('ai_actions','digital_employee','text'),
 ('ai_actions','outcome','text'),('ai_actions','summary','text'),('ai_actions','autonomous','boolean'),
 ('ai_actions','notification_sent','boolean'),('ai_actions','details','jsonb')
)
SELECT r.*,c.data_type AS actual_type FROM required r
LEFT JOIN information_schema.columns c ON c.table_schema='public' AND c.table_name=r.table_name AND c.column_name=r.column_name
WHERE c.column_name IS NULL OR c.data_type<>r.expected_type;

-- Must permit booking_cancelled/client_cancellation_fee action types and the
-- front_desk/money digital employees; outcome must allow pending.
SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
WHERE conrelid='public.ai_actions'::regclass AND contype='c' ORDER BY conname;

SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') ORDER BY rolname;

-- Run again after migration: service_role=true; anon/authenticated=false.
SELECT r.rolname,has_function_privilege(r.oid,p.oid,'EXECUTE') AS can_execute
FROM pg_roles r CROSS JOIN pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname='cancel_client_booking'
AND r.rolname IN ('anon','authenticated','service_role') ORDER BY r.rolname;
