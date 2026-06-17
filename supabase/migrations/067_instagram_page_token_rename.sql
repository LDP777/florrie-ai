-- 067_instagram_page_token_rename.sql
-- The code (instagram.js OAuth callback, ai-front-desk, notifications,
-- content-autopilot) all read/write beauticians.instagram_page_token, but the
-- column was created as instagram_token. That mismatch meant the Instagram
-- OAuth connect could never save credentials. Rename to match the code.
-- Guarded so it is safe to run once / skip if already applied.
do $$
begin
  if exists (
        select 1 from information_schema.columns
        where table_name = 'beauticians' and column_name = 'instagram_token'
      )
     and not exists (
        select 1 from information_schema.columns
        where table_name = 'beauticians' and column_name = 'instagram_page_token'
      )
  then
    alter table beauticians rename column instagram_token to instagram_page_token;
  end if;
end $$;
