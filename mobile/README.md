# Mobile (Capacitor) prototype

Wraps the Shelter route (`#/shelter`) as a native iOS/Android app via
Capacitor. **Additive** — the web build (`npm run build` → `dist/`) and
its Vercel deploy are unchanged. Mobile output lives in `dist-mobile/`.

## How it works

1. `mobile/build-mobile.mjs` runs `vite build` then copies `dist/` to
   `dist-mobile/`, patching only `index.html` to:
   - add `viewport-fit=cover` + `user-scalable=no` for WKWebView,
   - set `location.hash = '#/shelter'` before the bundle boots, so the
     app lands in the game instead of the docs home.
2. `capacitor.config.json` points Capacitor at `dist-mobile/`.
3. Native platform folders (`ios/`, `android/`) are added on demand
   (require Xcode / Android Studio locally) and are git-ignored.

The existing source under `src/` is untouched — nothing else in the
repo knows mobile exists.

## Commands

```bash
npm run mobile:build         # vite build + produce dist-mobile/
npm run mobile:add:ios       # one-time: scaffold ios/ project (needs Xcode)
npm run mobile:add:android   # one-time: scaffold android/ project (needs Android Studio)
npm run mobile:sync          # copy dist-mobile/ + plugins into native projects
npm run mobile:open:ios      # open ios/App.xcworkspace in Xcode
npm run mobile:open:android  # open android/ in Android Studio
```

Typical first run on a Mac:

```bash
npm run mobile:build
npm run mobile:add:ios
npm run mobile:sync
npm run mobile:open:ios      # then Run from Xcode
```

## What is NOT done yet (next milestones)

- Touch tuning for `dnd-kit` drag thresholds on small screens.
- Three.js perf budget (`renderer.setPixelRatio` cap, shadow map size).
- Safe-area CSS pass (`env(safe-area-inset-*)` in `src/styles.css`).
- Native plugins: `@capacitor/haptics`, `@capacitor/status-bar`,
  `@capacitor/splash-screen`, `@capacitor/app` (Android back button).
- Persistence migration `localStorage` → `@capacitor/preferences` for
  larger saves and resilience against iOS storage eviction.
- App icons + splash via `@capacitor/assets`.
- Store submission: privacy policy, screenshots, signing.

These intentionally land in follow-up changes so this prototype stays
risk-free for the existing web build.
