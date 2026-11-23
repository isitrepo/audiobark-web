// Where everything is kept, all on this phone only:
//  - IndexedDB "audiobark": the imported audio/cover files (store "files") and the book list (store "books");
//  - localStorage: small things - positions, speeds, bookmarks, chapter memory, settings.

const DB_NAME = 'audiobark';
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('books')) d.createObjectStore('books', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage transaction aborted'));
  });
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const Files = {
  put: (id, blob) => tx('files', 'readwrite', (s) => { s.put({ id, blob }); }),
  get: async (id) => (await tx('files', 'readonly', (s) => reqP(s.get(id))))?.blob ?? null,
  del: (id) => tx('files', 'readwrite', (s) => { s.delete(id); }),
};

export const Books = {
  all: async () => (await tx('books', 'readonly', (s) => reqP(s.getAll()))) || [],
  put: (book) => tx('books', 'readwrite', (s) => { s.put(book); }),
  del: (id) => tx('books', 'readwrite', (s) => { s.delete(id); }),
};

// ---------- small state in localStorage ----------
const K = 'ab.';
function getJ(key, dflt) {
  try { const v = localStorage.getItem(K + key); return v == null ? dflt : JSON.parse(v); } catch { return dflt; }
}
function setJ(key, val) {
  try {
    if (val === undefined || val === null) localStorage.removeItem(K + key);
    else localStorage.setItem(K + key, JSON.stringify(val));
  } catch { /* storage full or blocked: positions just won't persist */ }
}

export const State = {
  // where you are: { f: file index, t: seconds in file, at: when saved (ms) }
  position: (id) => getJ('pos.' + id, null),
  // `at` = when you were last listening (used by auto-rewind), not when the position was last written.
  setPosition: (id, f, t, at = Date.now()) => setJ('pos.' + id, { f, t, at }),
  speed: (id) => getJ('spd.' + id, 1),
  setSpeed: (id, v) => setJ('spd.' + id, v),
  finished: (id) => getJ('fin.' + id, false),
  setFinished: (id, v) => setJ('fin.' + id, v || null),
  bookmarks: (id) => getJ('bm.' + id, []),
  setBookmarks: (id, list) => setJ('bm.' + id, list.length ? list : null),
  // chapter index -> seconds into that chapter, for chapters left part-way
  chapterMemory: (id) => getJ('cm.' + id, {}),
  setChapterMemory: (id, m) => setJ('cm.' + id, Object.keys(m).length ? m : null),
  status(id) {
    if (State.finished(id)) return 'finished';
    return State.position(id) ? 'started' : 'new';
  },
  markNew(id) { ['pos.', 'fin.', 'cm.'].forEach((p) => setJ(p + id, null)); },
  forget(id) { ['pos.', 'fin.', 'cm.', 'spd.', 'bm.'].forEach((p) => setJ(p + id, null)); },
  lastBook: () => getJ('last', null),
  setLastBook: (id) => setJ('last', id),
};

export const Settings = {
  get theme() { return getJ('theme', 'system'); },          // system | light | dark
  set theme(v) { setJ('theme', v); },
  get rewind() { return getJ('rewind', 5); },               // seconds, 0 = off
  set rewind(v) { setJ('rewind', v); },
  get sleepMinutes() { return getJ('sleepMin', 15); },
  set sleepMinutes(v) { setJ('sleepMin', v); },
  get shake() { return getJ('shake', 1); },                 // 0 off, 1 any time, 2 only while fading
  set shake(v) { setJ('shake', v); },
  get shakeStrength() { return getJ('shakeStr', 1); },      // 0 light, 1 medium, 2 hard
  set shakeStrength(v) { setJ('shakeStr', v); },
};

export async function askPersistentStorage() {
  try { if (navigator.storage?.persist) return await navigator.storage.persist(); } catch { /* ignore */ }
  return false;
}

export async function storageUse() {
  try {
    if (navigator.storage?.estimate) {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      return { usage, quota };
    }
  } catch { /* ignore */ }
  return null;
}
