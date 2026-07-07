-- 036_profiles_is_admin.sql — APPLIED to production 2026-07-06.
--
-- Move admin identity out of the client bundle (audit M8). AuthContext.js
-- previously hardcoded the owner's email to unlock the "Preview as tier"
-- switcher; it now reads this server-side flag instead. is_admin grants NO
-- server privilege — it only toggles that client-side preview convenience.

alter table public.profiles add column if not exists is_admin boolean not null default false;

-- Flag your admin account(s) by user id (kept out of version control — run once
-- against the DB, substituting the owner email):
--   update public.profiles set is_admin = true
--   where id = (select id from auth.users where lower(email) = '<owner-email>');
