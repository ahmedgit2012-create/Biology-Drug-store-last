-- ================================================================
-- Biology Drug Store — Supabase schema
-- Run this once in the Supabase Dashboard: SQL Editor → New query → Run
-- ================================================================

-- ---------- PROFILES (app users; passwords are handled by Supabase Auth) ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  email text unique,
  role text not null check (role in ('admin','doctor','pharmacist','staff')),
  role_label text not null,
  color text not null default '#185FA5',
  spec text not null default '',
  dept text not null default '',
  created_at timestamptz not null default now()
);

-- helper used by RLS policies below to avoid recursive checks on profiles
create or replace function public.current_role()
returns text
language sql
security definer
stable
as $$
  select role from public.profiles where id = auth.uid();
$$;

alter table public.profiles enable row level security;

create policy "profiles_select_public" on public.profiles
  for select using (true);

create policy "profiles_insert_self_or_admin" on public.profiles
  for insert with check (id = auth.uid() or public.current_role() = 'admin');

create policy "profiles_update_self_or_admin" on public.profiles
  for update using (id = auth.uid() or public.current_role() = 'admin');

create policy "profiles_delete_admin" on public.profiles
  for delete using (public.current_role() = 'admin');

-- ---------- DRUGS ----------
create table public.drugs (
  id integer generated always as identity primary key,
  name text not null,
  brand text not null default '',
  cat text not null default '',
  total int not null default 0,
  dispensed int not null default 0 check (dispensed >= 0),
  reserved int not null default 0 check (reserved >= 0),
  expiry date,
  min_alert int not null default 10,
  created_at timestamptz not null default now()
);

alter table public.drugs enable row level security;

create policy "drugs_select" on public.drugs
  for select using (auth.uid() is not null);
create policy "drugs_insert" on public.drugs
  for insert with check (public.current_role() in ('admin','doctor'));
create policy "drugs_update" on public.drugs
  for update using (public.current_role() in ('admin','doctor','pharmacist'));
create policy "drugs_delete" on public.drugs
  for delete using (public.current_role() = 'admin');

-- ---------- PATIENTS ----------
create table public.patients (
  id integer generated always as identity primary key,
  name text not null,
  age int,
  gender text,
  mrn text,
  diag text,
  drug text,
  start date,
  dose text,
  notes text,
  doc_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.patients enable row level security;

create policy "patients_select" on public.patients
  for select using (
    public.current_role() in ('admin','pharmacist')
    or (public.current_role() = 'doctor' and doc_id = auth.uid())
  );
create policy "patients_insert" on public.patients
  for insert with check (public.current_role() in ('admin','doctor'));
create policy "patients_update" on public.patients
  for update using (
    public.current_role() = 'admin'
    or (public.current_role() = 'doctor' and doc_id = auth.uid())
  );
create policy "patients_delete" on public.patients
  for delete using (
    public.current_role() = 'admin'
    or (public.current_role() = 'doctor' and doc_id = auth.uid())
  );

-- ---------- RESERVATIONS ----------
create table public.reservations (
  id integer generated always as identity primary key,
  patient_id integer references public.patients(id) on delete cascade,
  drug_id integer references public.drugs(id) on delete cascade,
  qty int not null check (qty > 0),
  delivery date,
  created_at timestamptz not null default now()
);

alter table public.reservations enable row level security;

create policy "reservations_select" on public.reservations
  for select using (public.current_role() in ('admin','doctor','pharmacist'));
create policy "reservations_insert" on public.reservations
  for insert with check (public.current_role() in ('admin','doctor','pharmacist'));
create policy "reservations_delete" on public.reservations
  for delete using (public.current_role() in ('admin','doctor','pharmacist'));

-- ---------- SUPPLIES ----------
create table public.supplies (
  id integer generated always as identity primary key,
  drug text not null,
  supplier text,
  qty int not null check (qty > 0),
  refill date,
  pre_expiry date,
  expiry date,
  batch text,
  note text,
  created_at timestamptz not null default now()
);

alter table public.supplies enable row level security;

create policy "supplies_select" on public.supplies
  for select using (public.current_role() in ('admin','pharmacist','staff'));
create policy "supplies_insert" on public.supplies
  for insert with check (public.current_role() in ('admin','doctor'));
create policy "supplies_delete" on public.supplies
  for delete using (public.current_role() in ('admin','pharmacist','staff'));

-- ---------- HISTORY (audit log) ----------
create table public.history (
  id integer generated always as identity primary key,
  type text not null check (type in ('disp','res','add','supply')),
  drug text,
  patient text,
  qty int,
  note text,
  created_at timestamptz not null default now()
);

alter table public.history enable row level security;

create policy "history_select" on public.history
  for select using (auth.uid() is not null);
create policy "history_insert" on public.history
  for insert with check (auth.uid() is not null);
create policy "history_delete" on public.history
  for delete using (public.current_role() = 'admin');

-- ---------- REALTIME (live sync across all logged-in users) ----------
alter publication supabase_realtime add table
  public.drugs, public.patients, public.reservations, public.supplies, public.history, public.profiles;

-- ---------- SEED: initial biologic drug inventory ----------
insert into public.drugs (name,brand,cat,total,dispensed,reserved,expiry,min_alert) values
 ('إنفليكسيماب','Remicade','مضاد TNF-α',60,22,8,'2026-09-15',10),
 ('أداليموماب','Humira','مضاد TNF-α',80,35,12,'2026-07-20',10),
 ('فيدوليزوماب','Entyvio','مضاد انتغرين',40,18,6,'2027-02-10',8),
 ('أوستيكينوماب','Stelara','مضاد IL-12/23',30,10,5,'2026-11-30',5),
 ('ريساكيزوماب','Skyrizi','مضاد IL-23',20,8,4,'2026-06-05',5),
 ('توفاسيتينيب','Xeljanz','مضاد JAK',90,42,10,'2027-04-18',15),
 ('سيرتوليزوماب','Cimzia','مضاد TNF-α',25,14,3,'2026-08-22',5);

insert into public.supplies (drug,supplier,qty,refill,pre_expiry,expiry,batch,note) values
 ('إنفليكسيماب','شركة جانسن',20,'2025-12-01','2026-08-15','2026-09-15','JNS-2025-1201',''),
 ('أداليموماب','شركة أبفي',30,'2026-01-10','2026-06-20','2026-07-20','ABI-2026-0110',''),
 ('فيدوليزوماب','شركة تاكيدا',15,'2026-02-15','2027-01-10','2027-02-10','TKD-2026-0215','');

-- ================================================================
-- NEXT STEP — create the FIRST admin account (one-time, manual):
-- 1) Supabase Dashboard → Authentication → Users → Add user
--    Set an email + password, then COPY the generated User UID.
-- 2) Run this (replace the placeholders):
--
-- insert into public.profiles (id, name, email, role, role_label, color)
-- values ('PASTE-USER-UID-HERE', 'المدير', 'admin@example.com', 'admin', 'طبيب مدير', '#042C53');
--
-- After that, log into the app with that email/password — role "admin"
-- can then create doctor/pharmacist/staff accounts from the in-app admin panel.
-- ================================================================
