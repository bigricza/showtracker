-- Show Tracker: one row per user per tracked show.
create table public.showtracker_shows (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  show_id    integer not null,
  info       jsonb not null default '{}'::jsonb,
  my_link    text check (my_link is null or char_length(my_link) <= 2000),
  watched    jsonb not null default '{}'::jsonb,
  added_at   timestamptz not null default now(),
  last_touch timestamptz not null default now(),
  primary key (user_id, show_id),
  constraint showtracker_info_size check (pg_column_size(info) < 16384)
);

alter table public.showtracker_shows enable row level security;

create policy "showtracker_select_own" on public.showtracker_shows
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "showtracker_insert_own" on public.showtracker_shows
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "showtracker_update_own" on public.showtracker_shows
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "showtracker_delete_own" on public.showtracker_shows
  for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.showtracker_shows from anon;

-- Mark or unmark episodes atomically (merges into the watched map without overwriting other changes).
create or replace function public.showtracker_set_watched(p_show_id integer, p_eps integer[], p_on boolean)
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.showtracker_shows
  set watched = case
        when p_on then watched || coalesce(
          (select jsonb_object_agg(e::text, (extract(epoch from now()) * 1000)::bigint) from unnest(p_eps) as e),
          '{}'::jsonb)
        else watched - coalesce((select array_agg(e::text) from unnest(p_eps) as e), '{}'::text[])
      end,
      last_touch = now()
  where user_id = (select auth.uid()) and show_id = p_show_id;
$$;

revoke execute on function public.showtracker_set_watched(integer, integer[], boolean) from public, anon;
grant execute on function public.showtracker_set_watched(integer, integer[], boolean) to authenticated;

alter publication supabase_realtime add table public.showtracker_shows;
