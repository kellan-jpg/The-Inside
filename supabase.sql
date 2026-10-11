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

alter table public.requests enable row level security;
alter table public.updates enable row level security;
