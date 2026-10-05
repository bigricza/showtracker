# Show Tracker

A personal TV episode tracker. Search for a show, and it pulls in every season and episode from the free [TVmaze API](https://www.tvmaze.com/api). Tick off what you've watched, see what's next for each show and what airs in the next 30 days, and save a link to wherever you watch each show.

Sign in with your email and password, and your progress syncs across devices. Changes made on one device show up on the others straight away.

## How it's built

- **Frontend:** plain HTML, CSS and JavaScript in `public/` (no framework, no bundler).
- **Show data:** TVmaze, fetched in the browser. Episode lists are cached locally and refreshed every 12 hours.
- **Auth and data:** [Supabase](https://supabase.com). Email and password sign-in through Supabase Auth, and one row per tracked show in the `showtracker_shows` table: the show's details, your link, and a `watched` map of episode ID to the time you marked it.
- **Security:** row-level security means each signed-in user can only read and change their own rows. Episodes are marked through the `showtracker_set_watched` function, which merges changes so two devices can't overwrite each other.
- **Hosting:** [Vercel](https://vercel.com), deployed automatically on every push to `main`.

## Setup

### Database

Run `supabase/migrations/20261005000000_showtracker_init.sql` against your Supabase project, either in the SQL editor or with `supabase db push`. Table and function names are prefixed with `showtracker_`, so the app can share a project with other apps.

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
npx serve public
```

## Moving over from the single-file version

In the old `episode-tracker.html`, click **Export backup**. Then sign in to Show Tracker and click **Import backup**. Your shows, watched episodes and links are copied across.

## Credits

Show and episode data comes from [TVmaze](https://www.tvmaze.com), licensed under CC BY-SA.
