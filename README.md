# Show Tracker

A personal TV and movie tracker. Search for a show, and it pulls in every season and episode from the free [TVmaze API](https://www.tvmaze.com/api). Tick off what you've watched, see what's next for each show and what airs in the next 30 days, and save a link to wherever you watch each show.

Movies go on a watchlist. Add them from search (or by hand if they aren't found), save a link to where you'll watch each one, and mark them watched when you're done.

Sign in with your email and password, and your progress syncs across devices. Changes made on one device show up on the others straight away.

## How it's built

- **Frontend:** plain HTML, CSS and JavaScript in `public/` (no framework, no bundler).
- **Show data:** TVmaze, fetched in the browser. Episode lists are cached locally and refreshed every 12 hours.
- **Movie data:** a small Vercel function at `api/movies.js` searches two free sources and ranks the combined results. The iTunes Search API (South African and US stores) gives posters and full details for movies you can buy or rent. [Wikidata](https://www.wikidata.org) covers almost every film, including new and upcoming releases, and matches partial titles. No API keys are needed.
- **Auth and data:** [Supabase](https://supabase.com). Email and password sign-in through Supabase Auth, and one row per tracked show in the `showtracker_shows` table: the show's details, your link, and a `watched` map of episode ID to the time you marked it. Movies live in `showtracker_movies`, one row per movie, with your link and a status of `want` or `watched`.
- **Security:** row-level security means each signed-in user can only read and change their own rows. Episodes are marked through the `showtracker_set_watched` function, which merges changes so two devices can't overwrite each other.
- **Hosting:** [Vercel](https://vercel.com), deployed automatically on every push to `main`.

## Setup

### Database

Run the files in `supabase/migrations/` in order against your Supabase project, either in the SQL editor or with `supabase db push`. Table and function names are prefixed with `showtracker_`, so the app can share a project with other apps.

Sign-in uses the project's existing email and password accounts. The app has no sign-up screen, so create accounts under **Authentication > Users** in the Supabase dashboard.

### Hosting

The build step writes `public/config.js` from two environment variables:

| Variable | Value |
| --- | --- |
| `SUPABASE_URL` | Your project URL, `https://<project-ref>.supabase.co` |
| `SUPABASE_KEY` | The project's publishable (anon) key |

Both values are meant to be public. The database's row-level security is what protects the data. `config.js` is git-ignored anyway, so project details stay out of the repo.

On Vercel, import the repo and add the two variables. `vercel.json` sets the build command and serves `public/`.

### Run it locally

```bash
SUPABASE_URL=... SUPABASE_KEY=... node scripts/write-config.mjs
npx vercel dev
```

`vercel dev` serves `public/` and runs the movie search function. A plain static server works too, but movie search won't.

## Moving over from the single-file version

In the old `episode-tracker.html`, click **Export backup**. Then sign in to Show Tracker and click **Import backup**. Your shows, watched episodes and links are copied across.

## Credits

Show and episode data comes from [TVmaze](https://www.tvmaze.com), licensed under CC BY-SA. Movie details come from the iTunes Search API and [Wikidata](https://www.wikidata.org) (CC0).
