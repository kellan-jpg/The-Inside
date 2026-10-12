-- Run this once in Supabase: SQL Editor, paste it, press Run.

create table if not exists public.requests (
  id bigint generated always as identity primary key,
  message text not null check (char_length(message) between 3 and 500),
  created_at timestamptz not null default now()
);

create table if not exists public.updates (
  id bigint generated always as identity primary key,
  title text not null check (char_length(title) between 1 and 140),
  created_at timestamptz not null default now()
);

-- Turn on row level security and add NO policies on purpose.
-- That means the public key can't read or change either table.
-- Only your Worker (using your secret key) can. You read requests and
-- add updates in the Supabase dashboard, under Table Editor.
alter table public.requests enable row level security;
alter table public.updates enable row level security;
