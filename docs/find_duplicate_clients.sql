-- READ-ONLY. Finds client records that are almost certainly the same person
-- split across two rows (the real cause of "she showed earlier but her latest
-- message isn't there"). Paste into Supabase SQL editor. Nothing is changed.

-- 1) Duplicates by phone (ignores +, spaces, country-code formatting)
with norm as (
  select id, beautician_id, first_name, last_name, phone, whatsapp_id,
         instagram_id, email, created_at,
         regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g') as digits
  from clients
)
select digits as phone_digits,
       count(*)                                   as records,
       array_agg(id order by created_at)          as client_ids,
       array_agg(trim(coalesce(first_name,'')||' '||coalesce(last_name,'')) order by created_at) as names,
       array_agg(coalesce(instagram_id,'-')       order by created_at) as instagram_ids
from norm
where length(digits) >= 7
group by digits
having count(*) > 1
order by records desc;

-- 2) Instagram-only records (no phone) — these can't auto-link to a known
--    client because Instagram gives us no number. Candidates for a manual merge.
select id, first_name, last_name, instagram_id, created_at
from clients
where instagram_id is not null
  and (phone is null or phone = '')
order by created_at desc;
