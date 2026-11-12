/* Cloud sync: Google sign-in (Firebase Auth) + one Firestore document per user.
   The app keeps working offline from localStorage; this only merges and uploads.
   Access control lives in the Firestore security rules (users can only touch users/{their uid}).
   This config is meant to be public — it identifies the project, it does not grant access. */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, doc, runTransaction } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyAntc1Qu08iDLLFUP7rsNmYAplgsvKxm4c',
  authDomain: 'dutch-trainer-e8399.firebaseapp.com',
  projectId: 'dutch-trainer-e8399',
  storageBucket: 'dutch-trainer-e8399.firebasestorage.app',
  messagingSenderId: '620259480613',
  appId: '1:620259480613:web:c09131d54d48e76deb1bcc',
};

const DT = window.DT;
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const $ = (id) => document.getElementById(id);

let user = null;
let busy = false, again = false, timer = null;
let lastSync = null, lastError = '';

/* ---------- UI ---------- */
function el(tag, attrs = {}, text = '') {
  const e = document.createElement(tag);
  Object.assign(e, attrs);
  if (text) e.textContent = text;
  return e;
}
function render() {
  const box = $('syncBox'), badge = $('syncBadge'), home = $('syncHome');
  box.innerHTML = '';
  if (user) {
    const p = el('p', { className: 'small' });
    p.append('Signed in as ', el('b', {}, user.displayName || user.email || 'you'));
    if (user.email && user.displayName) p.append(` (${user.email})`);
    box.append(p);
    box.append(el('p', { className: 'muted small' }, busy ? 'Syncing…'
      : lastError ? '⚠ ' + lastError
      : lastSync ? `Progress synced at ${lastSync.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Sign in with the same Google account on your other devices.` : 'Connecting…'));
    const row = el('div', { className: 'stack-row' });
    const now = el('button', { type: 'button', className: 'btn small' }, 'Sync now');
    now.onclick = () => sync();
    const out = el('button', { type: 'button', className: 'btn small ghost' }, 'Sign out');
    out.onclick = async () => { await sync(); await signOut(auth); };
    row.append(now, out);
    box.append(row);
    badge.classList.remove('hidden');
    badge.dataset.state = busy ? 'busy' : lastError ? 'error' : 'ok';
    badge.title = busy ? 'Syncing…' : lastError ? 'Sync problem — open Settings' : 'Progress synced';
    home.classList.add('hidden');
  } else {
    box.append(el('p', { className: 'muted small' }, 'Sign in with Google to keep your progress in sync between your phone and computer. Without signing in, progress is saved in this browser only.'));
    const b = el('button', { type: 'button', className: 'btn small primary' }, 'Sign in with Google');
    b.onclick = signIn;
    box.append(b);
    if (lastError) box.append(el('p', { className: 'muted small' }, '⚠ ' + lastError));
    badge.classList.add('hidden');
    home.classList.remove('hidden');
  }
}

/* ---------- auth ---------- */
async function signIn() {
  lastError = '';
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') {
      await signInWithRedirect(auth, provider);
    } else if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') {
      lastError = 'Sign-in failed: ' + (e.code || e.message);
      render();
    }
  }
}

/* ---------- sync ---------- */
async function sync() {
  if (!user) return;
  if (busy) { again = true; return; }
  busy = true; again = false; render();
  const uid = user.uid;
  const startVersion = DT.version();
  try {
    let merged;
    await runTransaction(db, async (tx) => {
      const ref = doc(db, 'users', uid);
      const snap = await tx.get(ref);
      const local = DT.getState();
      let remote = null;
      if (snap.exists()) {
        try { remote = JSON.parse(snap.data().data); } catch (e) { remote = null; }
      }
      if (remote && local.syncUid && local.syncUid !== uid) {
        // this browser was last synced with a different Google account
        const keep = confirm('This browser has progress from a different Google account. Merge it into this account? (Cancel = use only this account’s progress here.)');
        merged = keep ? DT.merge(local, remote) : remote;
      } else {
        merged = remote ? DT.merge(local, remote) : local;
      }
      merged = Object.assign({}, merged, { syncUid: uid });
      const data = JSON.stringify(merged);
      if (data.length > 950000) throw new Error('Progress is too large to sync');
      tx.set(ref, { data, updated: Date.now(), v: 1 });
    });
    // fold in anything rated while we were talking to the server
    DT.replaceState(DT.merge(DT.getState(), merged));
    if (DT.version() !== startVersion) again = true;
    lastSync = new Date(); lastError = '';
  } catch (e) {
    lastError = e.code === 'permission-denied'
      ? 'The database refused access — the Firestore security rules still need to be set up.'
      : e.code === 'unavailable' || !navigator.onLine ? 'Offline — will sync when you’re back online.'
      : 'Sync failed: ' + (e.code || e.message);
  }
  busy = false;
  render();
  if (again) schedule(1500);
}
function schedule(ms = 4000) {
  clearTimeout(timer);
  timer = setTimeout(sync, ms);
}

DT.onLocalSave = () => { if (user) schedule(); };
document.addEventListener('visibilitychange', () => { if (user) (document.hidden ? sync() : schedule(300)); });
window.addEventListener('online', () => { if (user) schedule(300); });
setInterval(() => { if (user && !document.hidden) sync(); }, 5 * 60000);

getRedirectResult(auth).catch((e) => { lastError = 'Sign-in failed: ' + (e.code || e.message); render(); });
onAuthStateChanged(auth, (u) => {
  user = u; lastSync = null; lastError = '';
  render();
  if (u) sync();
});
render();
