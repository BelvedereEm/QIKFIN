/* ═══════════════════════════════════════════════════════
   QIKFIN — Morning Push Notification Sender
   Run by .github/workflows/morning-notifications.yml

   What it does:
   1. Reads every user's `recurring` items from Firestore
      (using the Firebase Admin SDK — full server access,
      bypasses the client-side security rules).
   2. Figures out what's due today / tomorrow (Eastern time).
   3. Sends a real Web Push notification to every subscription
      saved in `users/{uid}/pushSubscriptions` — this is what
      wakes a locked iPhone even with QikFin closed.

   Required secrets (set in GitHub repo Settings → Secrets →
   Actions — see the README this ships next to for exact steps):
     FIREBASE_SERVICE_ACCOUNT   (JSON, service account key)
     VAPID_PUBLIC_KEY
     VAPID_PRIVATE_KEY
     VAPID_SUBJECT              (mailto:you@example.com)
═══════════════════════════════════════════════════════ */

const admin = require("firebase-admin");
const webpush = require("web-push");

const TIMEZONE = "America/New_York";

/* ── Guard: only actually send during the Eastern morning window ──
   GitHub Actions cron is UTC-only and DST shifts the UTC offset for
   Eastern time twice a year, so instead of trying to get the cron
   expression exactly right, the workflow runs a little more often
   and THIS script decides whether it's actually "morning" before
   doing anything. Safe to run manually any time via workflow_dispatch
   (that always sends, ignoring the time-window guard), for testing. */
function isMorningWindowET() {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, hour: "2-digit", hour12: false }).format(new Date())
  );
  // Runs the send if the current Eastern hour is 4 (4:00–4:59am ET).
  return hour === 4;
}

function toDate(val) {
  if (!val) return null;
  if (val?.toDate) return val.toDate();
  if (val instanceof Date) return val;
  return new Date(val);
}

function dateToYMD(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit"
  }).format(date);
}

function advanceDate(date, frequency) {
  const d = new Date(date);
  switch (frequency) {
    case "weekly":   d.setDate(d.getDate() + 7);          break;
    case "biweekly": d.setDate(d.getDate() + 14);         break;
    case "monthly":  d.setMonth(d.getMonth() + 1);        break;
    case "yearly":   d.setFullYear(d.getFullYear() + 1);  break;
    default: return null;
  }
  return d;
}

function getEasternDates() {
  const fmt = date => dateToYMD(date);
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 86400000);
  return { today: fmt(now), tomorrow: fmt(tomorrow) };
}

// Same due-today/due-tomorrow logic as the in-app service worker check,
// but running server-side against every user instead of just the one
// with the app open.
function buildNotificationBody(recurringItems) {
  const { today, tomorrow } = getEasternDates();
  const todayItems = [];
  const tomorrowItems = [];

  recurringItems.forEach(item => {
    let d = item.nextDate ? toDate(item.nextDate) : null;
    if (!d) return;

    const limit = new Date();
    limit.setDate(limit.getDate() + 2);

    while (d && d <= limit) {
      const ymd = dateToYMD(d);
      const label = item.type === "income" ? "💰" : "💸";
      const sign = item.type === "income" ? "+" : "-";
      const amount = `${sign}$${Number(item.amount || 0).toFixed(2)}`;
      const entry = { name: item.name, amount, label };

      if (ymd === today) todayItems.push(entry);
      if (ymd === tomorrow) tomorrowItems.push(entry);

      d = advanceDate(d, item.frequency);
    }
  });

  if (todayItems.length === 0 && tomorrowItems.length === 0) return null;

  const lines = [];
  if (todayItems.length) {
    lines.push("Due today:");
    todayItems.forEach(i => lines.push(`${i.label} ${i.name} ${i.amount}`));
  }
  if (tomorrowItems.length) {
    if (lines.length) lines.push("");
    lines.push("Due tomorrow:");
    tomorrowItems.forEach(i => lines.push(`${i.label} ${i.name} ${i.amount}`));
  }

  return lines.join("\n");
}

async function main() {
  const forceSend = process.env.FORCE_SEND === "true"; // set by workflow_dispatch runs
  if (!forceSend && !isMorningWindowET()) {
    console.log("[QikFin] Not the Eastern morning window yet — skipping this run.");
    return;
  }

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT;

  if (!serviceAccountJson || !vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
    throw new Error(
      "Missing required secrets. Need FIREBASE_SERVICE_ACCOUNT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT."
    );
  }

  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(serviceAccountJson))
  });
  const db = admin.firestore();

  // Enumerate real accounts via Firebase Auth rather than listing the
  // Firestore "users" collection. Firestore only lists documents that
  // actually have data written to them at that exact path — if a user's
  // own users/{uid} doc was never written (only subcollections under it),
  // db.collection("users").get() silently skips them even though their
  // data exists. Auth's listUsers() is the real, complete source of truth
  // for "who has an account."
  const allUids = [];
  let pageToken;
  do {
    const page = await admin.auth().listUsers(1000, pageToken);
    page.users.forEach(u => allUids.push(u.uid));
    pageToken = page.pageToken;
  } while (pageToken);

  console.log(`[QikFin] Checking ${allUids.length} user(s)...`);

  let sent = 0;
  let removed = 0;

  for (const uid of allUids) {
    const recurringSnap = await db.collection("users").doc(uid).collection("recurring").get();
    if (recurringSnap.empty) {
      console.log(`[QikFin] User ${uid}: no recurring items at all — skipping.`);
      continue;
    }

    const recurringItems = recurringSnap.docs.map(d => d.data());
    const body = buildNotificationBody(recurringItems);
    if (!body) {
      console.log(`[QikFin] User ${uid}: has ${recurringItems.length} recurring item(s), but none due today/tomorrow — skipping.`);
      continue;
    }

    const subsSnap = await db.collection("users").doc(uid).collection("pushSubscriptions").get();
    if (subsSnap.empty) {
      console.log(`[QikFin] User ${uid}: has something due, but NO saved push subscription — skipping. (Re-check that the home screen app granted notification permission.)`);
      continue;
    }
    console.log(`[QikFin] User ${uid}: sending to ${subsSnap.size} subscription(s)...`);

    const payload = JSON.stringify({
      title: "QIKFIN — Morning Update",
      body,
      tag: "qikfin-morning",
      url: "/QIKFIN/"
    });

    for (const subDoc of subsSnap.docs) {
      const sub = subDoc.data();
      const pushSubscription = { endpoint: sub.endpoint, keys: sub.keys };

      try {
        await webpush.sendNotification(pushSubscription, payload);
        sent++;
      } catch (err) {
        // 404/410 = the subscription is gone (user uninstalled, revoked
        // permission, etc.) — clean it up so we stop trying forever.
        if (err.statusCode === 404 || err.statusCode === 410) {
          await subDoc.ref.delete();
          removed++;
          console.log(`[QikFin] Removed dead subscription for user ${uid}`);
        } else {
          console.error(`[QikFin] Push failed for user ${uid}:`, err.statusCode, err.body || err.message);
        }
      }
    }
  }

  console.log(`[QikFin] Done. Sent ${sent} notification(s), removed ${removed} dead subscription(s).`);
}

main().catch(err => {
  console.error("[QikFin] Fatal error:", err);
  process.exit(1);
});
