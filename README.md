# Show Tracker

A personal TV episode tracker. Search for a show, and it pulls in every season and episode from the free [TVmaze API](https://www.tvmaze.com/api). Tick off what you've watched, see what's next for each show and what airs in the next 30 days, and save a link to wherever you watch each show.

Sign in with Google and your progress syncs across devices through Firebase. It also works offline and syncs when you reconnect.

## How it's built

- **Frontend:** plain HTML, CSS and JavaScript in `public/` (no build step).
- **Show data:** TVmaze, fetched in the browser. Episode lists are cached locally and refreshed every 12 hours.
- **Auth:** Firebase Authentication with Google sign-in.
- **Data:** Cloud Firestore, one document per show at `users/{uid}/shows/{showId}`. Each document holds the show's details, your link, and a `watched` map of episode ID to the time you marked it.
- **Hosting:** Firebase Hosting.
- **Security:** `firestore.rules` lets each signed-in user read and write only their own shows.

## Setup

You need Node.js and a Google account. Everything here fits in Firebase's free Spark plan.

### 1. Create the Firebase project

1. Go to the [Firebase console](https://console.firebase.google.com/) and click **Create a project**. Google Analytics isn't needed.
2. **Build > Authentication > Get started**, then enable the **Google** sign-in provider.
3. **Build > Firestore Database > Create database**. Pick the location closest to you and start in **production mode**. The rules in this repo replace the defaults when you deploy.
4. **Project settings > General > Your apps**, then add a **Web app** (the `</>` icon). You don't need to tick Firebase Hosting here. Copy the `firebaseConfig` object it shows you.

### 2. Add your config

```bash
cp public/firebase-config.example.js public/firebase-config.js
```

Paste your values into `public/firebase-config.js`. This file is git-ignored. A Firebase web config isn't a secret (access is controlled by the security rules), but keeping it out of the repo keeps your project ID private.

### 3. Deploy

```bash
npm install -g firebase-tools
firebase login
firebase use --add          # pick your project; this writes .firebaserc (git-ignored)
firebase deploy             # deploys hosting + Firestore rules
```

The app goes live at `https://YOUR_PROJECT_ID.web.app`. On your phone, use **Add to Home Screen** for an app-like shortcut.

### Run it locally

```bash
firebase serve --only hosting
```

Then open http://localhost:5000. `localhost` is an authorised sign-in domain by default. If you put the app on a custom domain, add it under **Authentication > Settings > Authorized domains**.

## Moving over from the single-file version

In the old `episode-tracker.html`, click **Export backup**. Then sign in to Show Tracker and click **Import backup**. Your shows, watched episodes and links are copied across.

## Credits

Show and episode data comes from [TVmaze](https://www.tvmaze.com), licensed under CC BY-SA.
