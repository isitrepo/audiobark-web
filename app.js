// AudioBark for iPhone (web version). Everything runs on the phone; books are stored in the browser's storage.
import { Files, Books, State, Settings, askPersistentStorage, storageUse } from './store.js';
import { readMeta, probeDuration } from './meta.js';

export const VERSION = 'Web 1.0';

const $ = (s) => document.querySelector(s);
const audio = new Audio();
audio.preload = 'auto';

// ---------- small helpers ----------

const fmt = (sec) => {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};
const speedLabel = (s) => `${(+s.toFixed(2)).toString()}×`;
const AUDIO_EXT = ['mp3', 'm4a', 'm4b', 'aac', 'mp4', 'wav', 'flac', 'ogg', 'opus', 'caf', 'aif', 'aiff'];
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'heic'];
const ext = (name) => name.split('.').pop().toLowerCase();
const isAudio = (f) => AUDIO_EXT.includes(ext(f.name)) || f.type.startsWith('audio/');
const isImage = (f) => IMAGE_EXT.includes(ext(f.name)) || f.type.startsWith('image/');
const baseName = (name) => name.replace(/\.[^.]+$/, '');
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid);
  return e;
};
const icon = (id) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.innerHTML = `<use href="#${id}"/>`; return s; };

let toastTimer = 0;
function toast(msg, ms = 2500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------- theme ----------

function applyTheme() {
  const t = Settings.theme;
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = t;
}

// ---------- iOS: the first play must come straight from a tap ----------
// Playing a tiny silent sound during the first tap "unlocks" the audio element for later plays.
let unlocked = false;
const SILENT = (() => {
  const b = new ArrayBuffer(44 + 800), v = new DataView(b), w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + 800, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  w(36, 'data'); v.setUint32(40, 800, true); for (let i = 0; i < 800; i++) v.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
})();
function unlockAudio() {
  if (unlocked) return;
  unlocked = true;
  try {
    audio.src = SILENT;
    const p = audio.play();
    if (p) p.then(() => { if (audio.src === SILENT) audio.pause(); }).catch(() => {});
  } catch { /* ignore */ }
}

// ---------- player state ----------

const P = {
  book: null,      // the open book
  f: -1,           // index of the file loaded in the audio element
  url: null,       // object URL of that file
  ready: false,    // a real book file is loaded
  pendingT: null,  // seconds to seek to once the file's metadata is in
  wantPlay: false,
  chapter: -1,     // chapter index currently playing
  seeking: false,  // true between a seek we asked for and its completion
  pausedAt: 0,     // when playback last paused (for auto-rewind)
  lastSave: 0,
};

const durOf = (f) => P.book.files[f].dur || (f === P.f && Number.isFinite(audio.duration) ? audio.duration : 0);
const offsetOf = (f) => { let o = 0; for (let i = 0; i < f; i++) o += durOf(i); return o; };
const totalOf = () => P.book.files.reduce((s, _, i) => s + durOf(i), 0);
const chEnd = (ch) => (ch.end != null ? ch.end : durOf(ch.f));
function chapterAt(f, t) {
  const chs = P.book.chapters;
  let found = -1;
  for (let i = 0; i < chs.length; i++) if (chs[i].f === f && chs[i].start <= t + 0.05) found = i;
  if (found < 0) found = chs.findIndex((c) => c.f === f);
  return Math.max(0, found);
}
const nowF = () => (P.ready ? P.f : 0);
const nowT = () => (P.ready ? (P.pendingT ?? audio.currentTime) : 0);

function savePosition() {
  if (!P.book || !P.ready) return;
  // While paused, keep the time you actually stopped listening, so auto-rewind still works after reopening.
  const at = audio.paused ? (P.pausedAt || State.position(P.book.id)?.at || Date.now()) : Date.now();
  State.setPosition(P.book.id, P.f, nowT(), at);
  P.lastSave = Date.now();
}

async function loadFile(f, t, play) {
  const book = P.book;
  if (!book) return;
  t = Math.max(0, t || 0);
  if (P.f !== f || !P.ready) {
    const blob = await Files.get(book.files[f].id);
    if (P.book !== book) return;
    if (!blob) { toast("This book's audio is missing. Please import it again."); return; }
    if (P.url) URL.revokeObjectURL(P.url);
    P.url = URL.createObjectURL(blob);
    P.f = f;
    P.ready = true;
    P.pendingT = t;
    P.wantPlay = play;
    P.seeking = true;
    audio.src = P.url;
    audio.defaultPlaybackRate = audio.playbackRate = State.speed(book.id);
    audio.load();
    if (play) tryPlay();
  } else {
    P.seeking = true;
    audio.currentTime = t;
    if (play) tryPlay();
  }
  P.chapter = chapterAt(f, t);
  updateMediaMetadata();
  renderPlayer();
}

function tryPlay() {
  const p = audio.play();
  if (p) p.catch((e) => { if (e.name === 'NotAllowedError') toast('Tap play to start'); renderPlayer(); });
}

audio.addEventListener('loadedmetadata', () => {
  if (!P.ready || audio.src === SILENT) return;
  const f = P.book.files[P.f];
  if (Number.isFinite(audio.duration) && Math.abs((f.dur || 0) - audio.duration) > 1) {
    f.dur = audio.duration;
    Books.put(P.book);
  }
  if (P.pendingT != null) {
    audio.currentTime = Math.min(P.pendingT, Math.max(0, audio.duration - 0.5));
    P.pendingT = null;
  }
  audio.defaultPlaybackRate = audio.playbackRate = State.speed(P.book.id);
  if (P.wantPlay) { P.wantPlay = false; tryPlay(); }
  renderPlayer();
});
audio.addEventListener('seeked', () => { P.seeking = false; savePosition(); });

audio.addEventListener('timeupdate', () => {
  if (!P.ready || audio.src === SILENT) return;
  const ch = chapterAt(P.f, audio.currentTime);
  if (ch !== P.chapter) {
    // Played on into the next chapter: the one just finished starts from its beginning next time.
    if (!P.seeking && ch === P.chapter + 1) {
      forgetChapter(P.chapter);
      if (Sleep.endOfChapter) { audio.pause(); Sleep.cancel(); toast('Sleep timer: paused at end of chapter'); }
    }
    P.chapter = ch;
    updateMediaMetadata();
  }
  if (Date.now() - P.lastSave > 2000) savePosition();
  renderPlayer(true);
});

audio.addEventListener('ended', () => {
  if (!P.ready || audio.src === SILENT) return;
  if (P.f < P.book.files.length - 1) {
    forgetChapter(P.chapter);
    if (Sleep.endOfChapter) { Sleep.cancel(); loadFile(P.f + 1, 0, false); toast('Sleep timer: paused at end of chapter'); return; }
    loadFile(P.f + 1, 0, true);
  } else {
    State.setFinished(P.book.id, true);
    savePosition();
    toast('Finished! 🐾');
    renderLibrary();
  }
});
audio.addEventListener('play', () => { renderPlayer(); });
audio.addEventListener('pause', () => {
  if (!P.ready || audio.src === SILENT) return;
  P.pausedAt = Date.now();
  savePosition();
  renderPlayer();
  renderMini();
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') savePosition(); });
window.addEventListener('pagehide', savePosition);

// ---------- opening, playing, seeking ----------

async function openBook(book, play) {
  unlockAudio();
  if (P.book?.id === book.id && P.ready) {
    showPlayer();
    if (play && audio.paused) resume();
    return;
  }
  savePosition();
  audio.pause();
  P.book = book;
  P.f = -1;
  P.ready = false;
  if (State.finished(book.id)) State.markNew(book.id); // re-opening a finished book starts again
  const pos = State.position(book.id) || { f: 0, t: 0, at: 0 };
  P.pausedAt = pos.at || 0;
  State.setLastBook(book.id);
  showPlayer();
  await loadFile(Math.min(pos.f, book.files.length - 1), pos.t, false);
  if (play) resume();
  renderLibrary();
}

/** Play, first jumping back a little if it's been paused a while (auto-rewind). */
function resume() {
  if (!P.ready) return;
  const r = Settings.rewind;
  const away = P.pausedAt ? Date.now() - P.pausedAt : 0;
  if (r > 0 && away > 3000) {
    const back = away > 3600_000 ? r * 2 : r;
    seekGlobal(offsetOf(P.f) + nowT() - back, true);
  } else {
    tryPlay();
  }
  P.pausedAt = 0;
}
function togglePlay() {
  unlockAudio();
  if (!P.ready) { const b = books.find((x) => x.id === State.lastBook()); if (b) openBook(b, true); return; }
  if (audio.paused) resume(); else audio.pause();
}

function seekGlobal(g, play = !audio.paused) {
  const total = totalOf();
  g = Math.max(0, Math.min(g, Math.max(0, total - 0.5)));
  let f = 0;
  while (f < P.book.files.length - 1 && g >= offsetOf(f) + durOf(f)) f++;
  loadFile(f, g - offsetOf(f), play);
}
const jump = (sec) => { if (P.ready) seekGlobal(offsetOf(P.f) + nowT() + sec); };

// ---------- per-chapter memory ----------

function rememberChapter(i) {
  if (!P.book || i < 0) return;
  const ch = P.book.chapters[i];
  const pos = nowT() - ch.start, len = chEnd(ch) - ch.start;
  const m = State.chapterMemory(P.book.id);
  if (pos > 5 && pos < len - 5) m[i] = pos; else delete m[i];
  State.setChapterMemory(P.book.id, m);
}
function forgetChapter(i) {
  if (!P.book || i < 0) return;
  const m = State.chapterMemory(P.book.id);
  if (i in m) { delete m[i]; State.setChapterMemory(P.book.id, m); }
}
/** Go to a chapter. Unless exact, resume where you left it if you left part-way. */
function goChapter(i, exactSeconds = null) {
  if (!P.ready) return;
  const chs = P.book.chapters;
  i = Math.max(0, Math.min(i, chs.length - 1));
  if (i !== P.chapter) rememberChapter(P.chapter);
  const ch = chs[i];
  const into = exactSeconds != null ? exactSeconds : (State.chapterMemory(P.book.id)[i] || 0);
  loadFile(ch.f, ch.start + into, !audio.paused);
}

// ---------- sleep timer ----------

const Sleep = {
  left: null, full: 0, endOfChapter: false, timer: 0, last: 0, fadeMs: 20000,
  start(min) {
    this.cancel();
    Settings.sleepMinutes = min;
    this.full = this.left = min * 60000;
    this.last = Date.now();
    this.timer = setInterval(() => this.tick(), 250);
    Shake.start();
    renderPlayer();
  },
  startEndOfChapter() { this.cancel(); this.endOfChapter = true; renderPlayer(); },
  extend(min) { if (this.left != null) { this.left += min * 60000; audio.volume = 1; renderPlayer(); } },
  restart() { if (this.left != null) { this.left = this.full; audio.volume = 1; toast('Sleep timer restarted'); renderPlayer(); } },
  cancel() {
    clearInterval(this.timer);
    this.left = null; this.endOfChapter = false;
    audio.volume = 1;
    Shake.stop();
    renderPlayer();
  },
  tick() {
    const now = Date.now();
    if (!audio.paused) this.left -= now - this.last;
    this.last = now;
    if (this.left <= 0) { audio.pause(); this.cancel(); return; }
    // Fade out at the end (iPhone Safari ignores volume changes, so there it just stops).
    audio.volume = this.left < this.fadeMs ? Math.max(0.05, this.left / this.fadeMs) : 1;
    renderPlayer(true);
  },
};

// Shake the phone to restart the sleep timer. iPhone asks for motion permission the first time.
const Shake = {
  on: false, lastShake: 0,
  async askPermission() {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      try { return (await DeviceMotionEvent.requestPermission()) === 'granted'; } catch { return false; }
    }
    return true;
  },
  start() { if (Settings.shake && !this.on) { window.addEventListener('devicemotion', this.handler); this.on = true; } },
  stop() { if (this.on) { window.removeEventListener('devicemotion', this.handler); this.on = false; } },
  handler: (e) => {
    const a = e.accelerationIncludingGravity;
    if (!a || Sleep.left == null) return;
    const force = Math.sqrt((a.x || 0) ** 2 + (a.y || 0) ** 2 + (a.z || 0) ** 2) - 9.81;
    const need = [4, 7, 11][Settings.shakeStrength] ?? 7;
    if (force < need || Date.now() - Shake.lastShake < 1500) return;
    Shake.lastShake = Date.now();
    if (Settings.shake === 2 && Sleep.left >= Sleep.fadeMs) return;
    Sleep.restart();
  },
};

// ---------- lock screen / control centre ----------

const ms = 'mediaSession' in navigator ? navigator.mediaSession : null;
let coverUrlForSession = null;
async function updateMediaMetadata() {
  if (!ms || !P.book) return;
  const ch = P.book.chapters[P.chapter] || {};
  const artwork = [];
  const cover = await coverUrl(P.book);
  if (cover) artwork.push({ src: cover, sizes: '512x512' });
  artwork.push({ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' });
  coverUrlForSession = cover;
  try {
    ms.metadata = new MediaMetadata({ title: ch.title || P.book.title, artist: P.book.author || 'AudioBark', album: P.book.title, artwork });
  } catch { /* ignore */ }
}
function updatePositionState() {
  if (!ms?.setPositionState || !P.ready) return;
  const ch = P.book.chapters[P.chapter];
  if (!ch) return;
  const len = chEnd(ch) - ch.start;
  if (!(len > 0)) return;
  try { ms.setPositionState({ duration: len, position: Math.min(len, Math.max(0, nowT() - ch.start)), playbackRate: audio.playbackRate || 1 }); } catch { /* ignore */ }
}
if (ms) {
  const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch { /* not supported */ } };
  set('play', () => togglePlay());
  set('pause', () => audio.pause());
  set('seekbackward', (d) => jump(-(d?.seekOffset || 10)));
  set('seekforward', (d) => jump(d?.seekOffset || 10));
  // Car / headphone ⏮ ⏭ skip 10 seconds, like the Android version.
  set('previoustrack', () => jump(-10));
  set('nexttrack', () => jump(10));
  set('seekto', (d) => {
    const ch = P.book?.chapters[P.chapter];
    if (ch && d?.seekTime != null) loadFile(ch.f, ch.start + d.seekTime, !audio.paused);
  });
}

// ---------- covers ----------

const coverUrls = new Map();
async function coverUrl(book) {
  if (!book.coverId) return null;
  if (coverUrls.has(book.id)) return coverUrls.get(book.id);
  const blob = await Files.get(book.coverId);
  const url = blob ? URL.createObjectURL(blob) : null;
  coverUrls.set(book.id, url);
  return url;
}
async function paintCover(node, book) {
  node.textContent = (book.title || '?').trim().charAt(0).toUpperCase();
  node.style.backgroundImage = '';
  const url = await coverUrl(book);
  if (url) { node.style.backgroundImage = `url("${url}")`; node.textContent = ''; }
}

// ---------- library ----------

let books = [];
let tab = 'started';

async function loadBooks() {
  books = (await Books.all()).sort((a, b) => natural(a.title, b.title));
}

function progressOf(book) {
  const pos = State.position(book.id);
  if (!pos) return 0;
  const total = book.files.reduce((s, f) => s + (f.dur || 0), 0);
  if (!total) return 0;
  const before = book.files.slice(0, pos.f).reduce((s, f) => s + (f.dur || 0), 0);
  return Math.min(1, (before + pos.t) / total);
}
function chapterLine(book) {
  const pos = State.position(book.id);
  const n = book.chapters.length;
  if (!pos) return n > 1 ? `${n} chapters · not started` : 'Not started';
  let idx = 0;
  book.chapters.forEach((c, i) => { if (c.f < pos.f || (c.f === pos.f && c.start <= pos.t + 0.05)) idx = i; });
  return n > 1 ? `Chapter ${idx + 1} of ${n}` : 'Started';
}

function renderLibrary() {
  const counts = { new: 0, started: 0, finished: 0 };
  books.forEach((b) => counts[State.status(b.id)]++);
  document.querySelectorAll('.tabs button').forEach((b) => {
    const t = b.dataset.tab;
    b.classList.toggle('on', t === tab);
    b.textContent = `${t[0].toUpperCase()}${t.slice(1)} (${counts[t]})`;
  });
  const list = $('#bookList');
  list.replaceChildren();
  $('#empty').hidden = books.length > 0;
  list.hidden = books.length === 0;
  $('.tabs').hidden = books.length === 0;
  const shown = books.filter((b) => State.status(b.id) === tab);
  if (books.length && !shown.length) list.append(el('p', { class: 'hint center' }, `No ${tab} books.`));
  for (const book of shown) {
    const cover = el('div', { class: 'cover card-size' });
    paintCover(cover, book);
    const card = el('div', { class: 'card' + (P.book?.id === book.id ? ' current' : '') },
      el('button', { class: 'cover-btn', 'aria-label': 'Open ' + book.title, onclick: () => openBook(book, true) }, cover),
      el('button', { class: 'meta', onclick: () => openBook(book, true), style: 'text-align:left' },
        el('div', { class: 'title' }, book.title),
        book.author ? el('div', { class: 'group' }, book.author) : null,
        el('div', { class: 'sub' }, chapterLine(book)),
        el('div', { class: 'progress' }, el('i', { style: `width:${(progressOf(book) * 100).toFixed(1)}%` })),
      ),
      el('button', { class: 'icon-btn', 'aria-label': 'More options for ' + book.title, onclick: () => bookMenu(book) }, icon('i-more')),
    );
    list.append(card);
  }
  renderMini();
}

function renderMini() {
  const id = P.book?.id || State.lastBook();
  const book = books.find((b) => b.id === id);
  const mini = $('#mini');
  mini.hidden = !book || !$('#player').hidden;
  if (!book) return;
  $('#miniTitle').textContent = book.title;
  paintCover($('#miniCover'), book);
  const playing = P.book?.id === book.id && !audio.paused;
  $('#miniPlay use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('#miniPlay').setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

function bookMenu(book) {
  openDialog({
    title: book.title,
    body: el('ul', { class: 'menu' },
      el('li', {}, el('button', { type: 'button', onclick: () => { closeDialog(); State.markNew(book.id); if (P.book?.id === book.id) { audio.pause(); loadFile(0, 0, false); } renderLibrary(); } }, 'Mark as new (start over)')),
      el('li', {}, el('button', { type: 'button', onclick: () => { closeDialog(); State.setFinished(book.id, true); renderLibrary(); } }, 'Mark as finished')),
      el('li', {}, el('button', { type: 'button', class: 'btn danger', style: 'border:0;padding-left:4px', onclick: () => confirmDelete(book) }, 'Delete book from this phone')),
    ),
    actions: [{ label: 'Close' }],
  });
}

function confirmDelete(book) {
  openDialog({
    title: 'Delete this book?',
    body: el('p', {}, `“${book.title}” will be removed from AudioBark on this phone, with its position and bookmarks. The original files in the Files app are not touched.`),
    actions: [
      { label: 'Cancel' },
      { label: 'Delete', danger: true, onClick: async () => {
        if (P.book?.id === book.id) { audio.pause(); audio.removeAttribute('src'); P.book = null; P.ready = false; }
        for (const f of book.files) await Files.del(f.id);
        if (book.coverId) await Files.del(book.coverId);
        await Books.del(book.id);
        State.forget(book.id);
        coverUrls.delete(book.id);
        await loadBooks();
        renderLibrary();
        toast('Book deleted');
      } },
    ],
  });
}

// ---------- player screen ----------

function showPlayer() { $('#library').hidden = true; $('#player').hidden = false; renderPlayer(); window.scrollTo(0, 0); }
function showLibrary() { $('#player').hidden = true; $('#library').hidden = false; renderLibrary(); }

let dragging = false;
let lastCoverBook = null;
const overlayEl = $('#pOverlay'); // the big ▶ shown over the cover while paused
function renderPlayer(light = false) {
  if (!P.book || $('#player').hidden) { if (!light) renderMini(); return; }
  const book = P.book;
  const chs = book.chapters;
  const ch = chs[P.chapter] || chs[0];
  if (!light || lastCoverBook !== book.id) {
    $('#pTitle').textContent = book.title;
    const coverNode = $('#pCover');
    paintCover(coverNode, book).then(() => coverNode.append(overlayEl));
    coverNode.append(overlayEl);
    lastCoverBook = book.id;
  }
  $('#pChapter').textContent = ch?.title || '';
  $('#pChapterNo').textContent = chs.length > 1 ? `Chapter ${P.chapter + 1} of ${chs.length}` : '';
  const len = ch ? chEnd(ch) - ch.start : 0;
  const pos = ch ? Math.max(0, nowT() - ch.start) : 0;
  if (!dragging) {
    $('#pSeek').value = len > 0 ? Math.round((pos / len) * 1000) : 0;
    $('#pPos').textContent = fmt(pos);
    $('#pLeft').textContent = '-' + fmt(len - pos);
  }
  const playing = !audio.paused && audio.src !== SILENT;
  $('#pPlay use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('#pPlay').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('#pCover').classList.toggle('paused', !playing);
  $('#pSpeed span').textContent = speedLabel(State.speed(book.id));
  $('#pSleep span').textContent = Sleep.left != null ? fmt(Sleep.left / 1000) : Sleep.endOfChapter ? 'End of chapter' : 'Sleep';
  $('#pPrevCh').disabled = P.chapter <= 0;
  $('#pNextCh').disabled = P.chapter >= chs.length - 1;
  updatePositionState();
}

// ---------- dialogs ----------

const dlg = $('#dlg');
function openDialog({ title, body, actions = [{ label: 'Close' }] }) {
  const form = $('#dlgForm');
  form.replaceChildren(
    el('h3', { class: 'dlg-title' }, title),
    el('div', { class: 'dlg-body' }, body),
    el('div', { class: 'dlg-actions' }, actions.map((a) => {
      const b = el('button', { type: 'button', class: 'btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : '') }, a.label);
      b.addEventListener('click', async () => { const keep = a.onClick ? await a.onClick() : false; if (keep !== true) closeDialog(); });
      if (a.disabled) b.disabled = true;
      a.button = b;
      return b;
    })),
  );
  if (!dlg.open) dlg.showModal();
}
function closeDialog() { if (dlg.open) dlg.close(); }
dlg.addEventListener('click', (e) => { if (e.target === dlg) closeDialog(); }); // tap outside closes

function chips(options, selected, onSelect) {
  const wrap = el('div', { class: 'chips' });
  const draw = () => {
    wrap.replaceChildren(...options.map(([value, label]) =>
      el('button', { type: 'button', class: value === selected ? 'on' : '', onclick: () => { selected = value; onSelect(value); draw(); } }, label)));
  };
  draw();
  return wrap;
}

function speedDialog() {
  const id = P.book.id;
  let s = State.speed(id);
  const big = el('div', { class: 'big-number' }, speedLabel(s));
  const range = el('input', { type: 'range', min: '0.5', max: '3', step: '0.05', value: String(s), 'aria-label': 'Speed' });
  const set = (v) => {
    s = Math.min(3, Math.max(0.5, Math.round(v * 20) / 20));
    State.setSpeed(id, s);
    audio.defaultPlaybackRate = audio.playbackRate = s;
    big.textContent = speedLabel(s);
    range.value = String(s);
    renderPlayer();
  };
  range.addEventListener('input', () => set(+range.value));
  openDialog({
    title: 'Playback speed',
    body: el('div', {},
      big,
      el('div', { class: 'fields', style: 'align-items:center' },
        el('button', { type: 'button', class: 'btn', onclick: () => set(s - 0.05) }, '−'), range,
        el('button', { type: 'button', class: 'btn', onclick: () => set(s + 0.05) }, '+')),
      chips([0.8, 1, 1.2, 1.5, 1.75, 2].map((v) => [v, speedLabel(v)]), s, set),
      el('p', { class: 'hint' }, 'Saved separately for each book.')),
    actions: [{ label: 'Done', primary: true }],
  });
}

function sleepDialog() {
  const start = async (m) => {
    if (Settings.shake) await Shake.askPermission();
    Sleep.start(m);
    closeDialog();
  };
  const custom = el('input', { type: 'number', inputmode: 'numeric', min: '1', max: '1440', value: String(Settings.sleepMinutes), 'aria-label': 'Custom minutes' });
  const active = Sleep.left != null || Sleep.endOfChapter;
  openDialog({
    title: 'Sleep timer',
    body: el('div', {},
      active ? el('div', {},
        el('p', {}, Sleep.left != null ? `Stops in ${fmt(Sleep.left / 1000)}. Shake the phone to restart it.` : 'Stops at the end of this chapter.'),
        el('div', { class: 'chips' },
          Sleep.left != null ? el('button', { type: 'button', onclick: () => { Sleep.extend(5); closeDialog(); } }, '+5 min') : null,
          el('button', { type: 'button', onclick: () => { Sleep.cancel(); closeDialog(); } }, 'Turn off'))) : null,
      el('div', { class: 'section' }, 'Stop playing after… (minutes)'),
      el('div', { class: 'chips' }, [5, 10, 15, 20, 30, 45, 60, 90].map((m) => el('button', { type: 'button', onclick: () => start(m) }, String(m)))),
      el('div', { class: 'section' }, 'Custom'),
      el('div', { class: 'fields', style: 'align-items:end' },
        el('div', { class: 'field' }, el('label', {}, 'Minutes (1–1440)'), custom),
        el('button', { type: 'button', class: 'btn primary', style: 'margin-bottom:8px', onclick: () => {
          const m = parseInt(custom.value, 10);
          if (m >= 1 && m <= 1440) start(m); else toast('Enter 1 to 1440 minutes');
        } }, 'Start')),
      el('div', { class: 'chips', style: 'margin-top:8px' }, el('button', { type: 'button', onclick: () => { Sleep.startEndOfChapter(); closeDialog(); } }, 'At end of chapter'))),
    actions: [{ label: 'Close' }],
  });
}

function chaptersDialog() {
  const chs = P.book.chapters;
  const list = el('ul', { class: 'items' }, chs.map((c, i) =>
    el('li', { class: i === P.chapter ? 'on' : '', onclick: () => { goChapter(i); closeDialog(); } },
      el('span', { class: 'n' }, String(i + 1)), el('span', { class: 'grow' }, c.title))));
  openDialog({ title: 'Chapters', body: list, actions: [{ label: 'Close' }] });
  setTimeout(() => list.children[P.chapter]?.scrollIntoView({ block: 'center' }), 50);
}

function goToDialog() {
  const chs = P.book.chapters;
  const multi = chs.length > 1;
  const chIn = el('input', { type: 'number', inputmode: 'numeric', min: '1', max: String(chs.length), value: String(P.chapter + 1) });
  const minIn = el('input', { type: 'number', inputmode: 'numeric', min: '0', placeholder: '0' });
  const secIn = el('input', { type: 'number', inputmode: 'numeric', min: '0', placeholder: '0' });
  const note = el('p', { class: 'hint' });
  let go;
  const check = () => {
    const i = parseInt(chIn.value, 10) - 1;
    const ch = chs[i];
    const secs = (parseInt(minIn.value || '0', 10) * 60) + parseInt(secIn.value || '0', 10);
    const len = ch ? chEnd(ch) - ch.start : 0;
    let ok = !!ch && (minIn.value !== '' || secIn.value !== '');
    if (!ch) { note.textContent = `Choose a chapter from 1 to ${chs.length}.`; note.className = 'error'; }
    else if (len > 0 && secs >= len) { note.textContent = `That's past the end of this chapter (${fmt(len)} long).`; note.className = 'error'; ok = false; }
    else { note.textContent = (multi ? `“${ch.title}” is ` : 'This book is ') + (len ? `${fmt(len)} long.` : 'loading…'); note.className = 'hint'; }
    if (go) go.disabled = !ok;
    return ok ? { i, secs } : null;
  };
  [chIn, minIn, secIn].forEach((x) => x.addEventListener('input', check));
  openDialog({
    title: 'Go to time',
    body: el('div', {},
      multi ? el('div', { class: 'field' }, el('label', {}, `Chapter (1–${chs.length})`), chIn) : null,
      el('div', { class: 'fields' },
        el('div', { class: 'field' }, el('label', {}, 'Minutes'), minIn),
        el('div', { class: 'field' }, el('label', {}, 'Seconds'), secIn)),
      note),
    actions: [
      { label: 'Cancel' },
      { label: 'Go', primary: true, disabled: true, onClick: () => { const r = check(); if (!r) return true; goChapter(r.i, r.secs); } },
    ],
  });
  go = $('#dlgForm .dlg-actions .primary');
  check();
}

function bookmarksDialog() {
  const id = P.book.id;
  const noteIn = el('input', { type: 'text', placeholder: 'Note (optional)', 'aria-label': 'Bookmark note' });
  const list = el('ul', { class: 'items' });
  const draw = () => {
    const bms = State.bookmarks(id);
    list.replaceChildren(...(bms.length ? bms.map((b, k) => {
      const chIdx = chapterIndexFor(b.f, b.t);
      const ch = P.book.chapters[chIdx];
      const inCh = b.t - (ch?.start || 0);
      return el('li', {},
        el('button', { type: 'button', class: 'grow', style: 'text-align:left', onclick: () => { goChapter(chIdx, inCh); closeDialog(); } },
          el('div', {}, b.note || ch?.title || 'Bookmark'),
          el('div', { class: 'hint' }, (b.note ? `${ch?.title || ''} · ` : '') + fmt(inCh))),
        el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Delete bookmark', onclick: () => {
          const all = State.bookmarks(id); all.splice(k, 1); State.setBookmarks(id, all); draw();
        } }, icon('i-delete')));
    }) : [el('li', { class: 'hint' }, 'No bookmarks yet. Tap the bookmark button in the player.')]));
  };
  draw();
  openDialog({
    title: 'Bookmarks',
    body: el('div', {},
      el('div', { class: 'fields', style: 'align-items:center' }, el('div', { class: 'field' }, noteIn),
        el('button', { type: 'button', class: 'btn primary', onclick: () => { addBookmark(noteIn.value.trim()); noteIn.value = ''; draw(); } }, 'Add here')),
      list),
    actions: [{ label: 'Close' }],
  });
}
function chapterIndexFor(f, t) {
  let idx = 0;
  P.book.chapters.forEach((c, i) => { if (c.f < f || (c.f === f && c.start <= t + 0.05)) idx = i; });
  return idx;
}
function addBookmark(note = '') {
  if (!P.ready) return;
  const list = State.bookmarks(P.book.id);
  list.push({ f: P.f, t: nowT(), note, at: Date.now() });
  list.sort((a, b) => a.f - b.f || a.t - b.t);
  State.setBookmarks(P.book.id, list);
  toast(`Bookmark added at ${fmt(nowT() - (P.book.chapters[P.chapter]?.start || 0))}`);
}

async function settingsDialog() {
  const use = await storageUse();
  openDialog({
    title: 'Settings',
    body: el('div', {},
      el('div', { class: 'section' }, 'Theme'),
      chips([['system', 'Phone setting'], ['light', 'Light'], ['dark', 'Dark']], Settings.theme, (v) => { Settings.theme = v; applyTheme(); }),
      el('div', { class: 'section' }, 'Auto-rewind on resume'),
      el('p', { class: 'hint' }, 'Jumps back this far when you press play after a pause (double after more than an hour).'),
      chips([0, 2, 5, 10, 15, 30].map((v) => [v, v ? `${v} s` : 'Off']), Settings.rewind, (v) => { Settings.rewind = v; }),
      el('div', { class: 'section' }, 'Sleep timer: shake to restart'),
      chips([[0, 'Off'], [1, 'Any time'], [2, 'Only while fading']], Settings.shake, (v) => { Settings.shake = v; }),
      el('p', { class: 'hint' }, 'How hard to shake'),
      chips([[0, 'Light'], [1, 'Medium'], [2, 'Hard']], Settings.shakeStrength, (v) => { Settings.shakeStrength = v; }),
      el('div', { class: 'section' }, 'Storage'),
      el('p', { class: 'hint' }, use ? `Books are using ${(use.usage / 1e6).toFixed(0)} MB on this phone.` : 'Books are stored on this phone only.'),
      el('div', { style: 'margin:12px 0' }, el('button', { type: 'button', class: 'btn', style: 'width:100%', onclick: aboutDialog }, 'About AudioBark'))),
    actions: [{ label: 'Done', primary: true }],
  });
}

function aboutDialog() {
  openDialog({
    title: 'AudioBark',
    body: el('div', { class: 'center' },
      el('img', { class: 'about-icon', src: 'icons/icon-192.png', alt: '' }),
      el('p', { style: 'font-weight:600' }, `Version ${VERSION}`),
      el('p', {}, 'Made for the Dog Park Book Club, and for Honey Man. 🐾'),
      el('p', {}, 'For the stories we listen to between walks: picks up right where you left off, skips back when you drift off, and keeps your place in every chapter.'),
      el('p', { class: 'hint' }, 'Your books stay on this phone. Nothing is uploaded anywhere.')),
    actions: [{ label: 'Close' }],
  });
}

// ---------- importing ----------

function pickFiles() { const fp = $('#filePicker'); fp.value = ''; fp.click(); }

async function onFilesPicked(fileList) {
  const files = [...fileList];
  const audioFiles = files.filter(isAudio).sort((a, b) => natural(a.name, b.name));
  const images = files.filter((f) => isImage(f) && !isAudio(f));
  if (!audioFiles.length) { toast('No audio files were picked.'); return; }
  const first = await readMeta(audioFiles[0]);
  const guess = first.album || (audioFiles.length === 1 ? (first.title || baseName(audioFiles[0].name)) : commonPrefix(audioFiles.map((f) => baseName(f.name))) || baseName(audioFiles[0].name));
  const allBigBooks = audioFiles.length > 1 && audioFiles.every((f) => ext(f.name) === 'm4b');
  const titleIn = el('input', { type: 'text', value: guess, 'aria-label': 'Book title' });
  const sep = el('input', { type: 'checkbox', id: 'sepBooks' });
  sep.checked = allBigBooks;
  const totalMB = audioFiles.reduce((s, f) => s + f.size, 0) / 1e6;
  openDialog({
    title: 'Import book',
    body: el('div', {},
      el('p', { class: 'hint' }, `${audioFiles.length} audio file${audioFiles.length > 1 ? 's' : ''} (${totalMB.toFixed(0)} MB)` + (images.length ? ' and a cover picture' : '') + '.'),
      el('div', { class: 'field' }, el('label', {}, 'Title'), titleIn),
      audioFiles.length > 1 ? el('label', { class: 'toggle', for: 'sepBooks' }, el('span', {}, 'Each file is a separate book'), sep) : null,
      el('p', { class: 'hint' }, 'AudioBark keeps its own copy on this phone, so the book plays without internet.')),
    actions: [
      { label: 'Cancel' },
      { label: 'Import', primary: true, onClick: () => { runImport(audioFiles, images, sep.checked, titleIn.value.trim() || guess); } },
    ],
  });
}

function commonPrefix(names) {
  if (!names.length) return '';
  let p = names[0];
  for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1);
  return p.replace(/[\s._\-–(]*(part|chapter|track|cd|disc)?[\s._\-–]*\d*$/i, '').trim();
}

async function runImport(audioFiles, images, separate, title) {
  try {
    const groups = separate ? audioFiles.map((f) => [f]) : [audioFiles];
    let n = 0;
    for (const group of groups) {
      n++;
      toast(`Importing ${groups.length > 1 ? `${n} of ${groups.length}` : ''}… keep AudioBark open`, 600000);
      const meta0 = await readMeta(group[0]);
      const t = separate ? (meta0.album || meta0.title || baseName(group[0].name)) : title;
      await buildBook(t, group, separate ? [] : images);
    }
    await askPersistentStorage();
    await loadBooks();
    tab = 'new';
    renderLibrary();
    toast(groups.length > 1 ? `${groups.length} books imported` : 'Book imported');
  } catch (e) {
    console.error(e);
    toast(e?.name === 'QuotaExceededError' ? 'Not enough space on the phone for this book.' : `Import failed: ${e?.message || e}`, 6000);
  }
}

async function buildBook(title, files, images) {
  files = [...files].sort((a, b) => natural(a.name, b.name)); // Chapter_2 before Chapter_10
  const id = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const book = { id, title, author: null, coverId: null, files: [], chapters: [], added: Date.now() };
  let embeddedCover = null;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const [meta, dur] = await Promise.all([readMeta(file), probeDuration(file)]);
    const fid = `${id}.f${i}`;
    await Files.put(fid, file);
    book.files.push({ id: fid, name: file.name, dur });
    if (!book.author && meta.artist) book.author = meta.artist;
    if (!embeddedCover && meta.cover) embeddedCover = meta.cover;
    const base = baseName(file.name);
    if (meta.chapters.length > 1) {
      meta.chapters.forEach((c, j) => book.chapters.push({
        f: i, start: c.start, end: meta.chapters[j + 1]?.start ?? null,
        title: files.length > 1 ? `${base} · ${c.title}` : c.title,
      }));
    } else {
      book.chapters.push({ f: i, start: 0, end: null, title: files.length === 1 ? (meta.title || base) : base });
    }
  }
  const picked = images.find((f) => /^(cover|folder|front)/i.test(f.name)) || images[0];
  const cover = picked || embeddedCover;
  if (cover) { book.coverId = `${id}.cover`; await Files.put(book.coverId, cover); }
  await Books.put(book);
  return book;
}

// ---------- wiring ----------

function wire() {
  $('#btnImport').onclick = pickFiles;
  $('#btnImportEmpty').onclick = pickFiles;
  $('#filePicker').addEventListener('change', (e) => onFilesPicked(e.target.files));
  $('#btnSettings').onclick = settingsDialog;
  document.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => { tab = b.dataset.tab; renderLibrary(); }; });
  $('#mini').addEventListener('click', (e) => {
    if (e.target.closest('#miniPlay')) return;
    const b = books.find((x) => x.id === (P.book?.id || State.lastBook()));
    if (b) openBook(b, false);
  });
  $('#miniPlay').onclick = () => togglePlay();

  $('#btnBack').onclick = showLibrary;
  $('#pCover').onclick = togglePlay;
  $('#pPlay').onclick = togglePlay;
  document.querySelectorAll('[data-jump]').forEach((b) => { b.onclick = () => jump(+b.dataset.jump); });
  $('#pPrevCh').onclick = () => goChapter(P.chapter - 1);
  $('#pNextCh').onclick = () => goChapter(P.chapter + 1);
  $('#pChapterNo').onclick = chaptersDialog;
  $('#pChapter').onclick = () => { if (P.book?.chapters.length > 1) chaptersDialog(); };
  $('#btnGoTo').onclick = goToDialog;
  $('#pSpeed').onclick = speedDialog;
  $('#pSleep').onclick = sleepDialog;
  $('#btnBookmarkAdd').onclick = () => addBookmark('');
  $('#btnBookmarks').onclick = bookmarksDialog;

  const seek = $('#pSeek');
  const preview = () => {
    const ch = P.book?.chapters[P.chapter];
    if (!ch) return null;
    const len = chEnd(ch) - ch.start;
    const pos = (seek.value / 1000) * len;
    $('#pPos').textContent = fmt(pos);
    $('#pLeft').textContent = '-' + fmt(len - pos);
    return { ch, pos };
  };
  seek.addEventListener('input', () => { dragging = true; preview(); });
  seek.addEventListener('change', () => {
    const r = preview();
    dragging = false;
    if (r) loadFile(r.ch.f, r.ch.start + r.pos, !audio.paused);
  });

  window.addEventListener('popstate', () => { if (!$('#player').hidden) showLibrary(); });
}

async function main() {
  applyTheme();
  wire();
  await loadBooks();
  renderLibrary();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  setInterval(() => { if (P.book && !audio.paused) updatePositionState(); }, 5000);
}

main();

// For testing from the browser console.
window.AudioBark = { importFiles: (files, opts = {}) => runImport([...files].filter(isAudio), [...files].filter(isImage), !!opts.separate, opts.title || 'Test book'), state: P, audio, books: () => books };
