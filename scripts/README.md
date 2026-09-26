# QikFin Morning Push Notifications — Setup

This makes QikFin send a real push notification every morning at ~7:05am
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

## One-time setup

### 1. Generate VAPID keys (or use these — see note below)
A VAPID key pair was already generated for you during setup:


The **public** key is already in `index.html` (safe — it's meant to be
public). The **private** key must never be committed to git — it only
goes into a GitHub secret (step 3). If you'd rather generate your own
fresh pair instead of using the one above: `npx web-push generate-vapid-keys`.

### 2. Get a Firebase service account key
This lets the GitHub Action read/write Firestore with full admin access
(bypassing your client security rules), since it isn't a signed-in user.

1. Firebase Console → Project Settings → Service Accounts
2. "Generate new private key" → downloads a JSON file
3. Keep this file secret — treat it like a password. Don't commit it.

### 3. Add GitHub repo secrets
Repo → Settings → Secrets and variables → Actions → New repository secret.
Add all four:

| Secret name | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | The entire contents of the JSON file from step 2, pasted as-is |
| `VAPID_PUBLIC_KEY` | The public key from step 1 |
| `VAPID_PRIVATE_KEY` | The private key from step 1 |
| `VAPID_SUBJECT` | `mailto:youremail@example.com` (any contact email — required by the push spec) |

### 4. Firestore security rules
Add this to your Firestore rules so users can only write their own push
subscriptions (adjust to match your existing rules structure):

```
match /users/{uid}/pushSubscriptions/{subId} {
  allow read, write: if request.auth != null && request.auth.uid == uid;
}
```

### 5. Push this code to GitHub
Commit and push everything (`index.html`, `service-worker.js`,
`scripts/`, `.github/workflows/morning-notifications.yml`). The
workflow won't appear under the Actions tab until it's on the default
branch.

## Testing

1. On your iPhone: open QikFin from the home screen, log in, grant
   notification permission when prompted.
2. In Firebase Console → Firestore, confirm a document appeared under
   `users/{your uid}/pushSubscriptions`.
3. Add a recurring bill/income dated today or tomorrow if you don't
   have one already (so there's something to notify about).
4. GitHub repo → Actions tab → "QikFin Morning Notifications" →
   "Run workflow" (this is the `workflow_dispatch` button — it sends
   immediately, ignoring the 7am check).
5. You should get a lock-screen notification within a minute or two.
6. Check the workflow run's logs if nothing arrives — it prints how many
   users were checked and how many notifications were sent.

## How the DST/timezone handling works

GitHub Actions' `schedule` cron is UTC-only with no reliable per-entry
timezone support, and US Eastern's UTC offset changes twice a year with
DST. Rather than trying to get a single cron expression exactly right
year-round, the workflow schedule fires at **both** UTC times that could
correspond to 7:05am Eastern (11:05 UTC and 12:05 UTC), and
`send-notifications.js` itself checks the current Eastern hour and exits
immediately unless it's 7am — so it only actually sends once per real
morning, and never drifts when clocks change. Manual "Run workflow"
clicks always send immediately for testing, regardless of the hour.

## Notes / things to know

- This uses the standard **Web Push API** (works in any Web Push-capable
  browser/OS, including iOS 16.4+ PWAs) — not Firebase Cloud Messaging
  and not Apple's native APNs directly. No Apple Developer account is
  needed for this to work.
- If you also build the native iOS app via Capacitor (see the other
  project doc, `ios-app-capacitor-setup.md`), that native app would use
  a *different* mechanism (`@capacitor/push-notifications` + real APNs)
  — the two aren't the same pipeline. This Web Push setup is for the
  "Add to Home Screen" PWA version specifically.
