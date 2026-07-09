create extension if not exists "pgcrypto";

create table if not exists public.app_settings (
  user_id uuid references auth.users(id) on delete cascade,
  company_name text not null default 'Minha IPTV Legal',
  owner_name text,
  default_method text not null default 'Pix',
  mask_phones boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.app_settings add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table public.app_settings add column if not exists company_name text default 'Minha IPTV Legal';
alter table public.app_settings add column if not exists owner_name text;
alter table public.app_settings add column if not exists default_method text default 'Pix';
alter table public.app_settings add column if not exists mask_phones boolean default false;
alter table public.app_settings add column if not exists created_at timestamptz default now();
alter table public.app_settings add column if not exists updated_at timestamptz default now();
create unique index if not exists app_settings_user_id_idx on public.app_settings(user_id);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'app_settings_user_id_key'
  ) then
    alter table public.app_settings add constraint app_settings_user_id_key unique (user_id);
  end if;
end $$;

create table if not exists public.plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  name text not null,
  price numeric(12,2) not null default 0,
  duration_months integer not null default 1,
  screens integer not null default 1,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.plans add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table public.plans add column if not exists name text;
alter table public.plans add column if not exists price numeric(12,2) default 0;
alter table public.plans add column if not exists duration_months integer default 1;
alter table public.plans add column if not exists screens integer default 1;
alter table public.plans add column if not exists notes text;
alter table public.plans add column if not exists active boolean default true;
alter table public.plans add column if not exists created_at timestamptz default now();
alter table public.plans add column if not exists updated_at timestamptz default now();

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
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

alter table public.clients add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table public.clients add column if not exists name text;
alter table public.clients add column if not exists phone text;
alter table public.clients add column if not exists email text;
alter table public.clients add column if not exists plan_id uuid references public.plans(id) on delete set null;
alter table public.clients add column if not exists monthly_value numeric(12,2) default 0;
alter table public.clients add column if not exists due_date date;
alter table public.clients add column if not exists status text default 'active';
alter table public.clients add column if not exists notes text;
alter table public.clients add column if not exists created_at timestamptz default now();
alter table public.clients add column if not exists updated_at timestamptz default now();

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
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

alter table public.payments add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table public.payments add column if not exists client_id uuid references public.clients(id) on delete cascade;
alter table public.payments add column if not exists amount numeric(12,2) default 0;
alter table public.payments add column if not exists status text default 'received';
alter table public.payments add column if not exists method text;
alter table public.payments add column if not exists due_date date;
alter table public.payments add column if not exists paid_at date;
alter table public.payments add column if not exists notes text;
alter table public.payments add column if not exists created_at timestamptz default now();
alter table public.payments add column if not exists updated_at timestamptz default now();

create table if not exists public.message_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  type text not null,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, type)
);

alter table public.message_templates add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table public.message_templates add column if not exists type text;
alter table public.message_templates add column if not exists body text;
alter table public.message_templates add column if not exists created_at timestamptz default now();
alter table public.message_templates add column if not exists updated_at timestamptz default now();
create unique index if not exists message_templates_user_type_idx on public.message_templates(user_id, type);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'message_templates_user_id_type_key'
  ) then
    alter table public.message_templates add constraint message_templates_user_id_type_key unique (user_id, type);
  end if;
end $$;

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  entity text not null,
  entity_id text,
  action text not null,
  summary text not null,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now()
);

alter table public.audit_logs add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table public.audit_logs add column if not exists entity text;
alter table public.audit_logs add column if not exists entity_id text;
alter table public.audit_logs add column if not exists action text;
alter table public.audit_logs add column if not exists summary text;
alter table public.audit_logs add column if not exists old_data jsonb;
alter table public.audit_logs add column if not exists new_data jsonb;
alter table public.audit_logs add column if not exists created_at timestamptz default now();

create index if not exists clients_user_due_idx on public.clients(user_id, due_date);
create index if not exists clients_user_status_idx on public.clients(user_id, status);
create index if not exists payments_user_paid_idx on public.payments(user_id, paid_at);
create index if not exists payments_user_due_idx on public.payments(user_id, due_date);

alter table public.app_settings enable row level security;
alter table public.plans enable row level security;
alter table public.clients enable row level security;
alter table public.payments enable row level security;
alter table public.message_templates enable row level security;
alter table public.audit_logs enable row level security;

do $$
declare
  policy_record record;
begin
  for policy_record in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'app_settings',
        'plans',
        'clients',
        'payments',
        'message_templates',
        'audit_logs'
      )
  loop
    execute format(
      'drop policy if exists %I on %I.%I',
      policy_record.policyname,
      policy_record.schemaname,
      policy_record.tablename
    );
  end loop;
end $$;

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
