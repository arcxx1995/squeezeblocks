// In-memory stand-in for @devvit/web/server's `redis`, honoring the
// WATCH/MULTI/EXEC optimistic-locking contract game.ts relies on. Every method
// is async so concurrent updateGame() chains interleave at real await points —
// that's what stresses the CAS retry loop.

const store = new Map(); // key -> string
const version = new Map(); // key -> number (bumped on every committed write)
const zsets = new Map(); // key -> Map<member, score>

function bump(key) {
  version.set(key, (version.get(key) ?? 0) + 1);
}

export const redis = {
  async get(key) {
    return store.has(key) ? store.get(key) : null;
  },
  async set(key, val) {
    store.set(key, val);
    bump(key);
  },
  async del(key) {
    store.delete(key);
    bump(key);
  },
  async watch(key) {
    const snapshot = version.get(key) ?? 0;
    let queued = null;
    return {
      async unwatch() {},
      async multi() {
        queued = [];
      },
      async set(k, v) {
        queued.push([k, v]);
      },
      async exec() {
        // Atomic CAS: check watched version, then apply — no await between.
        if ((version.get(key) ?? 0) !== snapshot) return null; // changed → fail
        for (const [k, v] of queued) {
          store.set(k, v);
          bump(k);
        }
        return queued.map(() => "OK");
      },
    };
  },
  async zAdd(key, ...entries) {
    const flat = entries.flat();
    let z = zsets.get(key);
    if (!z) zsets.set(key, (z = new Map()));
    for (const { member, score } of flat) z.set(member, score);
  },
  async zRem(key, members) {
    const z = zsets.get(key);
    if (!z) return;
    for (const m of members) z.delete(m);
  },
  async zRange(key, min, max, opts) {
    const z = zsets.get(key);
    if (!z) return [];
    const byScore = opts?.by === "score";
    return [...z.entries()]
      .filter(([, score]) => (byScore ? score >= min && score <= max : true))
      .sort((a, b) => a[1] - b[1])
      .map(([member, score]) => ({ member, score }));
  },
};

// Captured outbound effects so notify/broadcast can be asserted.
export const sentDMs = []; // { to, subject, text }
export const sentRealtime = []; // { channel, message }

export const setFlairs = []; // { username, text }

export const reddit = {
  async sendPrivateMessage({ to, subject, text }) {
    sentDMs.push({ to, subject, text });
  },
  async setUserFlair({ username, text }) {
    setFlairs.push({ username, text });
  },
};
export const realtime = {
  async send(channel, message) {
    sentRealtime.push({ channel, message });
  },
};
export const context = {};

// Test-only: wipe state between scenarios.
export function __reset() {
  store.clear();
  version.clear();
  zsets.clear();
  sentDMs.length = 0;
  sentRealtime.length = 0;
  setFlairs.length = 0;
}
