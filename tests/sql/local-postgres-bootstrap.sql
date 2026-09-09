-- Minimal Supabase-owned objects required to compile the schema in plain Postgres.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema extensions;
create schema auth;
create table auth.users (id uuid primary key);
