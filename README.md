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

## Updating from Git

Push a change to `main`. GitHub Pages republishes in about a minute. The app fetches the newest files every time it opens, so the next time you open it you have the update. No reinstall needed.

## Notes

- The gong is synthesized in the browser, so no audio files are needed. Swap in a recorded gong by replacing the `strike()` function in `app.js`.
- Volume goes up to 300% and is limited so it does not distort.
- Keep the screen on during a session. Locked phones may pause the audio.

## Files

- `index.html`, `styles.css`, `app.js`: the app
- `sw.js`: offline cache, network-first so updates arrive automatically
- `manifest.webmanifest`, `icon.svg`: home-screen install
