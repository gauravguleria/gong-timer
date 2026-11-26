# Gong Timer

A phone app that rings a meditation gong at set times. Each bell has a delay and a number of gongs.

## How the schedule works

- **Starts after**: the delay before the first bell, counted from pressing Start.
- **Then after**: each later delay is counted from the previous bell.
- **Gongs**: how many times that bell rings. Gongs within one bell are spaced by the "Gap between strikes" setting.
- **Repeat whole schedule**: runs the whole list again, chained after the last bell.

The default schedule is four bells, each 15 minutes apart, ringing 1, 2, 3 and 4 times.

## Install on your phone (one time)

1. Push this folder to a GitHub repository (see below).
2. In the repo: **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)`**.
3. Open the Pages URL on your phone.
4. Add it to your home screen:
   - **iPhone (Safari):** Share → Add to Home Screen
   - **Android (Chrome):** menu → Install app / Add to Home screen

## Updating from Git (automatic)

Every push to `main` is published by GitHub Pages within about a minute. The app always fetches the newest files from GitHub when it opens, so you get the update the next time you open it. You never reinstall or re-download anything.

## Use your own gong recording

Put your meditation gong recording in the repo at `sounds/gong.mp3`. The app plays that file for every strike. If the file is missing, it uses the built-in synthesized gong.

## Notes

- The built-in gong is synthesized in the browser. A real recording of a meditation gong sounds better, so use one when you can.
- Volume goes up to 300% and is limited so it does not distort.
- Keep the screen on during a session. Locked phones may pause the audio.

## Files

- `index.html`, `styles.css`, `app.js`: the app
- `sw.js`: offline cache, network-first so updates arrive automatically
- `manifest.webmanifest`, `icon.svg`: home-screen install
