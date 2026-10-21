-- Show Tracker movies: one row per user per movie on their list.
-- movie_key is "itunes:<trackId>" for catalogue movies or "manual:<uuid>" for ones added by hand.
create table public.showtracker_movies (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  movie_key  text not null check (char_length(movie_key) between 3 and 80),
  info       jsonb not null default '{}'::jsonb,
  my_link    text check (my_link is null or char_length(my_link) <= 2000),
  status     text not null default 'want' check (status in ('want', 'watched')),
  watched_at timestamptz,
  added_at   timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, movie_key),
  constraint showtracker_movie_info_size check (pg_column_size(info) < 16384)
);

alter table public.showtracker_movies enable row level security;

create policy "showtracker_movies_select_own" on public.showtracker_movies
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "showtracker_movies_insert_own" on public.showtracker_movies
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "showtracker_movies_update_own" on public.showtracker_movies
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "showtracker_movies_delete_own" on public.showtracker_movies
  for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.showtracker_movies from anon;

alter publication supabase_realtime add table public.showtracker_movies;
