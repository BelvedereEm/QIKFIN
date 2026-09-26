# QikFin Morning Push Notifications — Setup

This makes QikFin send a real push notification every morning at ~4:30am
Eastern, even when your iPhone is locked and QikFin isn't open. It works
by:

1. Your phone subscribing to Web Push the first time you grant
   notification permission inside the installed QikFin app.
2. That subscription being saved to Firestore (`users/{uid}/pushSubscriptions`).
3. A GitHub Actions workflow running every morning, reading everyone's
   recurring bills/income from Firestore, and sending a push to every
   saved subscription via the `web-push` library.

## Requirements before this works on your iPhone

- **iOS 16.4 or later.**
- **QikFin must be "Added to Home Screen"** — Web Push notifications on
  iOS only work for installed PWAs, not for a page open in a Safari tab.
  If you already had it added, remove it and re-add it once after
  deploying this update, so it picks up the new service worker.
- Open QikFin from the home screen icon (not Safari) at least once and
  grant notification permission when asked — that's what triggers
  `subscribeToPush()` in `index.html` and saves your subscription.
