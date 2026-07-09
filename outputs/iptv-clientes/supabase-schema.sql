create extension if not exists "pgcrypto";

create table public.app_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  company_name text not null default 'Minha IPTV Legal',
  owner_name text,
  default_method text not null default 'Pix',
  mask_phones boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  price numeric(12,2) not null default 0,
  duration_months integer not null default 1,
  screens integer not null default 1,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  phone text not null,
  email text,
  plan_id uuid references public.plans(id) on delete set null,
  monthly_value numeric(12,2) not null default 0,
  due_date date not null,
  status text not null default 'active'
    check (status in ('active', 'trial', 'cancelled')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  amount numeric(12,2) not null default 0,
  status text not null default 'received'
    check (status in ('received', 'pending')),
  method text,
  due_date date not null,
  paid_at date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.message_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, type)
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entity text not null,
  entity_id text,
  action text not null,
  summary text not null,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now()
);

create index clients_user_due_idx on public.clients(user_id, due_date);
create index clients_user_status_idx on public.clients(user_id, status);
create index payments_user_paid_idx on public.payments(user_id, paid_at);
create index payments_user_due_idx on public.payments(user_id, due_date);

alter table public.app_settings enable row level security;
alter table public.plans enable row level security;
alter table public.clients enable row level security;
alter table public.payments enable row level security;
alter table public.message_templates enable row level security;
alter table public.audit_logs enable row level security;

create policy "settings owner access" on public.app_settings
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "plans owner access" on public.plans
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "clients owner access" on public.clients
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "payments owner access" on public.payments
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "templates owner access" on public.message_templates
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "audit owner access" on public.audit_logs
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
