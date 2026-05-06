/* ═══════════════════════════════════════════
   QIKFIN Service Worker
   - Caches app shell for offline use
   - Checks Firestore for upcoming bills/income
   - Fires push notifications for today & tomorrow
═══════════════════════════════════════════ */

importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js");

const CACHE_NAME = "qikfin-v1";
const TIMEZONE   = "America/New_York";

/* ── Firebase config ── */
const firebaseConfig = {
  apiKey:            "AIzaSyBUxKRW99n3MdM3h5lIthrSLhtysqKOHwE",
  authDomain:        "qikfin.firebaseapp.com",
  projectId:         "qikfin",
  storageBucket:     "qikfin.firebasestorage.app",
  messagingSenderId: "867906265805",
  appId:             "1:867906265805:web:fef99742609ce5151e3f84"
};

if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

/* ═══════════════════════════════════════════
   INSTALL & ACTIVATE
═══════════════════════════════════════════ */
self.addEventListener("install",  e => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(clients.claim()));

/* ═══════════════════════════════════════════
   NOTIFICATION CLICK
═══════════════════════════════════════════ */
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      if (list.length > 0) return list[0].focus();
      return clients.openWindow("/QIKFIN/");
    })
  );
});

/* ═══════════════════════════════════════════
   MESSAGE FROM APP — trigger a check
═══════════════════════════════════════════ */
self.addEventListener("message", e => {
  if (e.data?.type === "CHECK_NOTIFICATIONS") {
    checkAndNotify(e.data.uid);
  }
});

/* ═══════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════ */
function toDate(val) {
  if (!val) return null;
  if (val?.toDate) return val.toDate();
  if (val instanceof Date) return val;
  return new Date(val);
}

// Get today and tomorrow in Eastern Time as YYYY-MM-DD strings
function getEasternDates() {
  const fmt = date =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TIMEZONE,
      year: "numeric", month: "2-digit", day: "2-digit"
    }).format(date);

  const now      = new Date();
  const tomorrow = new Date(now.getTime() + 86400000);

  return { today: fmt(now), tomorrow: fmt(tomorrow) };
}

function dateToYMD(date) {
  if (!date) return null;
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

/* ═══════════════════════════════════════════
   ALREADY NOTIFIED TODAY? (avoid duplicates)
═══════════════════════════════════════════ */
function alreadyNotifiedKey(uid) {
  return `qikfin_notified_${uid}`;
}

function alreadyNotifiedToday(uid) {
  const key  = alreadyNotifiedKey(uid);
  const last = self.__notifyCache?.[key];
  if (!last) return false;
  const { today } = getEasternDates();
  return last === today;
}

function markNotifiedToday(uid) {
  if (!self.__notifyCache) self.__notifyCache = {};
  const { today } = getEasternDates();
  self.__notifyCache[alreadyNotifiedKey(uid)] = today;
}

/* ═══════════════════════════════════════════
   MAIN CHECK FUNCTION
═══════════════════════════════════════════ */
async function checkAndNotify(uid) {
  if (!uid) return;
  if (alreadyNotifiedToday(uid)) return;

  const { today, tomorrow } = getEasternDates();

  try {
    const snap = await db.collection("users").doc(uid).collection("recurring").get();
    const todayItems    = [];
    const tomorrowItems = [];

    snap.forEach(docSnap => {
      const item = docSnap.data();
      let d = toDate(item.nextDate);
      if (!d) return;

      // Walk occurrences to find any hitting today or tomorrow
      const limit = new Date();
      limit.setDate(limit.getDate() + 2); // only look 2 days ahead

      while (d && d <= limit) {
        const ymd = dateToYMD(d);
        const label  = item.type === "income" ? "💰" : "💸";
        const sign   = item.type === "income" ? "+" : "-";
        const amount = `${sign}$${Number(item.amount).toFixed(2)}`;
        const entry  = { name: item.name, amount, label, type: item.type };

        if (ymd === today)    todayItems.push(entry);
        if (ymd === tomorrow) tomorrowItems.push(entry);

        d = advanceDate(d, item.frequency);
      }
    });

    // Fire notifications
    if (tomorrowItems.length > 0) {
      const lines = tomorrowItems.map(i => `${i.label} ${i.name} ${i.amount}`).join("\n");
      await self.registration.showNotification("QIKFIN — Due Tomorrow", {
        body: lines,
        icon: "/QIKFIN/QikFin-Logo.png",
        badge: "/QIKFIN/apple-touch-icon.png",
        tag: "qikfin-tomorrow",
        renotify: true,
        data: { url: "/QIKFIN/" }
      });
    }

    if (todayItems.length > 0) {
      const lines = todayItems.map(i => `${i.label} ${i.name} ${i.amount}`).join("\n");
      await self.registration.showNotification("QIKFIN — Due Today", {
        body: lines,
        icon: "/QIKFIN/QikFin-Logo.png",
        badge: "/QIKFIN/apple-touch-icon.png",
        tag: "qikfin-today",
        renotify: true,
        data: { url: "/QIKFIN/" }
      });
    }

    markNotifiedToday(uid);

  } catch (err) {
    console.error("[QikFin SW] Notification check failed:", err);
  }
}
