-- READ ONLY. Run before the migration; inspect names/counts, never token values.
-- Save the output privately for the release record.
SELECT grantee,privilege_type FROM information_schema.role_table_grants
WHERE table_schema='public' AND table_name='beauticians' AND grantee IN ('anon','authenticated','PUBLIC') ORDER BY 1,2;
SELECT grantee,column_name,privilege_type FROM information_schema.column_privileges
WHERE table_schema='public' AND table_name='beauticians' AND grantee IN ('anon','authenticated','PUBLIC') ORDER BY 1,2,3;
SELECT policyname,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' AND tablename IN ('beauticians','account_deletions');
SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('beauticians','stripe_events') ORDER BY table_name,ordinal_position;
-- Every non-cascading FK must be handled explicitly before account deletion.
SELECT conrelid::regclass AS child_table,conname,pg_get_constraintdef(oid) AS definition
FROM pg_constraint WHERE contype='f' AND confrelid='public.beauticians'::regclass ORDER BY 1,2;
-- Tables with an owner column but no FK need a separate retention/erase decision.
SELECT c.table_name FROM information_schema.columns c
WHERE c.table_schema='public' AND c.column_name='beautician_id'
AND NOT EXISTS(SELECT 1 FROM pg_constraint k JOIN pg_class t ON t.oid=k.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE k.contype='f' AND k.confrelid='public.beauticians'::regclass AND n.nspname=c.table_schema AND t.relname=c.table_name)
ORDER BY 1;
SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='storage' AND table_name='objects';
SELECT bucket_id,count(*) FROM storage.objects GROUP BY bucket_id;
-- After migration: ordinary auth must have no table-wide mutation privileges.
SELECT role,has_table_privilege(role,'public.beauticians','INSERT') AS can_insert,
 has_table_privilege(role,'public.beauticians','UPDATE') AS whole_row_update,
 has_table_privilege(role,'public.beauticians','DELETE') AS can_delete,
 has_table_privilege(role,'public.beauticians','TRUNCATE') AS can_truncate,
 has_table_privilege(role,'public.beauticians','TRIGGER') AS can_create_trigger
FROM unnest(ARRAY['anon','authenticated']) role;

-- All rows must be true before applying the migration.
SELECT required.table_name,required.column_name,EXISTS(
 SELECT 1 FROM information_schema.columns actual WHERE actual.table_schema='public'
 AND actual.table_name=required.table_name AND actual.column_name=required.column_name
) AS column_exists FROM (VALUES ('beauticians','id'),('beauticians','auth_id'),
 ('deleted_appointments','beautician_id'),('stripe_events','beautician_id'),('stripe_events','data'),('stripe_events','processed_at')) AS required(table_name,column_name);
