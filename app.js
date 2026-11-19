import { firebaseConfig } from './firebase-config.js';
import { CHILD_NAME, LIST_ID, FIRST_XMAS } from './lista.js';
const APP_VERSION = '17';

/* ───────────── Utilità ───────────── */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ALPHA = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newId = (n = 20) => [...crypto.getRandomValues(new Uint8Array(n))].map(x => ALPHA[x % ALPHA.length]).join('');
const err = code => Object.assign(new Error(code), { code });
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(err('timeout')), ms))]);
const mem = {};
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? (k in mem ? mem[k] : d) : JSON.parse(v); } catch { return k in mem ? mem[k] : d; } },
  set(k, v) { mem[k] = v; try { localStorage.setItem(k, JSON.stringify(v)); } catch { } }
};
function normalizeUrl(u) {
  u = (u || '').trim(); if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; }
}
const shopOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const baseUrl = () => location.href.split('#')[0];
const isFree = it => (it.status || 'free') === 'free';

/* ───────────── Archivio: Firebase (tempo reale) ───────────── */
async function createFirebaseStore(cfg) {
  const base = 'https://www.gstatic.com/firebasejs/11.0.2/';
  const [{ initializeApp }, A, F] = await Promise.all([
    import(base + 'firebase-app.js'), import(base + 'firebase-auth.js'), import(base + 'firebase-firestore.js')]);
  const app = initializeApp(cfg);
  // Niente IndexedDB: nelle app aggiunte alla Home di iPhone a volte si blocca.
  // La lista si legge dal server (cache in memoria) e l'accesso anonimo resta nel localStorage.
  let db;
  try { db = F.initializeFirestore(app, { localCache: F.memoryLocalCache() }); }
  catch { db = F.getFirestore(app); }
  let auth;
  try { auth = A.initializeAuth(app, { persistence: [A.browserLocalPersistence, A.inMemoryPersistence] }); }
  catch { auth = A.getAuth(app); }
  if (!auth.currentUser) await A.signInAnonymously(auth);
  const uid = auth.currentUser.uid;
  const L = F.doc(db, 'lists', LIST_ID);
  const I = iid => F.doc(db, 'lists', LIST_ID, 'items', iid);
  const E = F.doc(db, 'lists', LIST_ID, 'editors', uid);
  const K = key => F.doc(db, 'lists', LIST_ID, 'keys', key);

  return {
    mode: 'live', uid,
    watchList: (cb, onErr) => F.onSnapshot(L, s => cb(s.exists() ? s.data() : null), onErr),
    watchItems: (cb, onErr) => F.onSnapshot(F.collection(db, 'lists', LIST_ID, 'items'), s => cb(s.docs.map(d => ({ id: d.id, ...d.data() }))), onErr),
    watchEditor: cb => F.onSnapshot(E, s => cb(s.exists()), () => cb(false)),
    setup(key) {
      const b = F.writeBatch(db);
      b.set(L, { child: CHILD_NAME, ownerUid: uid, createdAt: Date.now() });
      b.set(K(key), { createdAt: Date.now() });
      b.set(E, { key, createdAt: Date.now() });
      return b.commit();
    },
    async joinAsEditor(key) {
      // 1) la password esiste? (chiesto sempre al server, mai alla copia sul telefono)
      let k;
      try { k = await F.getDocFromServer(K(key)); }
      catch (e) { throw err(e && e.code === 'permission-denied' ? 'auth:' + e.code : (e && e.code) || 'unavailable'); }
      if (!k.exists()) throw err('badpass');
      // 2) questo telefono è già dentro?
      try { const s = await F.getDocFromServer(E); if (s.exists()) return; } catch { }
      // 3) entro
      try { await F.setDoc(E, { key, createdAt: Date.now() }); }
      catch (e) { throw err('write:' + ((e && e.code) || '?')); }
    },
    // Nuova password: resta valida solo lei. Con kickOthers escono anche gli altri telefoni.
    async changePassword(key, kickOthers) {
      await F.setDoc(K(key), { createdAt: Date.now() });
      let ks, es = null;
      try {
        ks = await F.getDocs(F.collection(db, 'lists', LIST_ID, 'keys'));
        if (kickOthers) es = await F.getDocs(F.collection(db, 'lists', LIST_ID, 'editors'));
      } catch (e) { throw err(e && e.code === 'permission-denied' ? 'rules' : (e && e.code) || 'unavailable'); }
      const b = F.writeBatch(db);
      ks.docs.forEach(d => { if (d.id !== key) b.delete(d.ref); });
      if (es) es.docs.forEach(d => { if (d.id !== uid) b.delete(d.ref); });
      await b.commit();
      return { removed: ks.docs.filter(d => d.id !== key).length, kicked: es ? es.docs.filter(d => d.id !== uid).length : 0 };
    },
    leave: () => F.deleteDoc(E),
    addItem: data => F.setDoc(I(newId()), { ...data, status: 'free', takenUid: '', takenAt: 0, createdAt: Date.now() }),
    updateItem: (iid, data) => F.updateDoc(I(iid), data),
    deleteItem: iid => F.deleteDoc(I(iid)),
    async take(iid) {
      const patch = { status: 'taken', takenUid: uid, takenAt: Date.now() };
      try {
        await F.runTransaction(db, async tx => {
          const s = await tx.get(I(iid));
          if (!s.exists()) throw err('gone');
          if ((s.data().status || 'free') !== 'free') throw err('taken');
          tx.update(I(iid), patch);
        });
      } catch (e) {
        if (e.code === 'taken' || e.code === 'gone') throw e;
        if (e.code === 'unavailable' || !navigator.onLine) return F.updateDoc(I(iid), patch); // offline: si sincronizza dopo
        throw e;
      }
    },
    untake: iid => F.updateDoc(I(iid), { status: 'free', takenUid: '', takenAt: 0 })
  };
}

/* ───────────── Archivio: demo locale (anteprima senza Firebase) ───────────── */
function createLocalStore() {
  const KEY = LIST_ID + '-demo-db';
  const load = () => ls.get(KEY, null) || { list: null, items: {} };
  const subs = new Set();
  const notify = () => subs.forEach(f => f());
  let bc = null;
  try { bc = new BroadcastChannel(LIST_ID + '-demo'); bc.onmessage = notify; } catch { }
  window.addEventListener('storage', e => { if (e.key === KEY) notify(); });
  const save = d => { ls.set(KEY, d); notify(); try { bc && bc.postMessage(1); } catch { } };
  const sub = f => { subs.add(f); setTimeout(f, 40); return () => subs.delete(f); };
  const edit = fn => { const d = load(); fn(d); save(d); };
  let uid = ls.get(LIST_ID + '-demo-uid', null);
  if (!uid) { uid = newId(12); ls.set(LIST_ID + '-demo-uid', uid); }
  // In demo chi apre la pagina è il genitore
  if (!load().list) save({ list: { child: CHILD_NAME, ownerUid: uid, editors: [uid], keys: [] }, items: {} });

  return {
    mode: 'demo', uid,
    watchList: cb => sub(() => cb(load().list)),
    watchItems: cb => sub(() => cb(Object.entries(load().items).map(([id, v]) => ({ id, ...v })))),
    watchEditor: cb => sub(() => cb((load().list?.editors || []).includes(uid))),
    async setup() { },
    async joinAsEditor(key) { edit(d => { if (!(d.list.keys || []).includes(key)) throw err('badpass'); d.list.editors = [...new Set([...(d.list.editors || []), uid])]; }); },
    async changePassword(key, kickOthers) {
      let r = {};
      edit(d => { r.removed = (d.list.keys || []).filter(k => k !== key).length; d.list.keys = [key];
        if (kickOthers) { r.kicked = (d.list.editors || []).filter(x => x !== uid).length; d.list.editors = [uid]; } });
      return r;
    },
    async leave() { edit(d => { d.list.editors = (d.list.editors || []).filter(x => x !== uid); }); },
    async addItem(data) { edit(d => { d.items[newId()] = { ...data, status: 'free', takenUid: '', takenAt: 0, createdAt: Date.now() }; }); },
    async updateItem(iid, data) { edit(d => { if (!d.items[iid]) throw err('gone'); Object.assign(d.items[iid], data); }); },
    async deleteItem(iid) { edit(d => { delete d.items[iid]; }); },
    async take(iid) {
      edit(d => {
        const it = d.items[iid];
        if (!it) throw err('gone');
        if (!isFree(it)) throw err('taken');
        Object.assign(it, { status: 'taken', takenUid: uid, takenAt: Date.now() });
      });
    },
    async untake(iid) { edit(d => { if (d.items[iid]) Object.assign(d.items[iid], { status: 'free', takenUid: '', takenAt: 0 }); }); }
  };
}

/* ───────────── Stato ───────────── */
const S = {
  store: null, list: undefined, items: [], editor: false, preview: false,
  slow: false, setupMode: false, leaving: new Set()
};
const app = $('#app');
const canEdit = () => S.editor && !S.preview;
// La password non è mai salvata: nel database finisce solo la sua impronta SHA-256
async function hashPass(pw) {
  const clean = String(pw).normalize('NFKC').replace(/[\s\/.\-]+/g, '');
  const data = new TextEncoder().encode(LIST_ID + ':' + clean);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const fail = e => { console.error(e); toast(e && e.code === 'gone' ? 'Questo regalo non c\'è più' : 'Qualcosa è andato storto, riprova'); };

/* ───────────── Render ───────────── */
function render() {
  const mb = $('.menu-btn');
  mb.classList.toggle('hide', S.list === undefined || (S.list === null && !S.setupMode));
  mb.textContent = S.editor ? '⋯' : '🔒';
  mb.setAttribute('aria-label', S.editor ? 'Menu' : 'Area genitori');
  const edit = canEdit();

  if (S.list === undefined) {
    app.innerHTML = `<main>${S.slow ? `<div class="banner">⏳ <span>Connessione lenta: la lista si aggiornerà da sola.</span></div>` : ''}</main>`;
    return;
  }
  if (S.list === null) {
    app.innerHTML = `<main><div class="empty"><div class="big">✨</div><p>La lista arriverà presto</p>
      ${S.setupMode ? `<button class="btn btn-red" data-action="setup" style="margin-top:14px">Prepara la lista di ${esc(CHILD_NAME)}</button>` : ''}</div></main>`;
    return;
  }

  const sorted = [...S.items].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const free = sorted.filter(isFree);
  const taken = sorted.filter(i => !isFree(i)).sort((a, b) => (b.takenAt || 0) - (a.takenAt || 0));
  const mine = taken.filter(i => i.takenUid === S.store.uid);

  let html = '';
  if (S.preview) html += `<div class="banner">👀 <span>Anteprima: così la vedono parenti e amici.</span><button class="btn btn-fir btn-sm" data-action="preview">Esci</button></div>`;
  else if (edit && S.store.mode === 'demo') html += `<div class="banner">ℹ️ <span>Anteprima dimostrativa: i dati restano su questo dispositivo.</span></div>`;

  html += free.map((it, i) => giftCard(it, edit, i === 0)).join('');

  if (!free.length) {
    html += `<article class="gift letter"><div class="gh"><span class="script first">Caro Babbo Natale, vorrei…</span></div>
      <p class="note">${S.items.length ? 'Tutti i regali sono stati scelti. Grazie di cuore! 🎄' : (edit ? 'Aggiungi il primo regalo con il pacco qui sotto.' : 'La lista arriverà presto ✨')}</p></article>`;
  }

  // Il genitore vede cosa è già stato preso (senza nomi); gli ospiti solo i propri
  const list = edit ? taken : mine;
  if (list.length) {
    html += `<details class="taken"><summary>${edit ? `Già presi · ${list.length}` : `Li regali tu · ${list.length}`}</summary>
      ${list.map(it => `<div class="taken-row"><span>${esc(it.name)}</span>
        ${(it.takenUid === S.store.uid || edit) ? `<button class="btn btn-line btn-sm" data-action="untake" data-id="${esc(it.id)}">Rimetti in lista</button>` : ''}</div>`).join('')}
    </details>`;
  }

  const open = app.querySelector('details.taken')?.open;
  const homeBtn = canOfferHome() ? `<button class="btn btn-line btn-sm" data-action="home">📲 Aggiungi alla Home</button>` : '';
  if (!S.editor || homeBtn) html += `<div class="parents">${!S.editor ? `<button class="btn btn-line btn-sm" data-action="login">🔒 Area genitori</button>` : ''}${homeBtn}</div>`;
  html += `<div class="ver">v${APP_VERSION}${isStandalone() ? ' · app' : ''}</div>`;
  app.innerHTML = `<main>${html}</main>${edit ? `<button class="fab-gift" data-action="add" aria-label="Aggiungi regalo"><img src="img/fab.png" alt="+ Aggiungi regalo" width="338" height="144"></button>` : ''}`;
  if (open) app.querySelector('details.taken')?.setAttribute('open', '');
}

// Piccola icona accanto al regalo, scelta dal nome
const ICONS = [
  [/cavall|dondol/, '🐴'], [/trenin|treno|locomotiv/, '🚂'], [/orsacch|orsett|orso|peluche|pupazz/, '🧸'],
  [/bambol/, '🪆'], [/libr|fiab|storie/, '📚'], [/pall[ao]|calcio/, '⚽'], [/bici|tricicl|monopatt/, '🚲'],
  [/macchin|auto|camion|trattor/, '🚗'], [/puzzle|incastr/, '🧩'], [/music|carillon|pianol|tambur|xilofon|canzon/, '🎵'],
  [/lego|costruz|mattonc|cubi\b/, '🧱'], [/vestit|body|tutin|maglion|felp|pigiam|abitin|salopette/, '👗'],
  [/scarp|calz|stivalett/, '🧦'], [/copert|plaid|sacco nanna|cusci/, '🛏️'], [/biberon|pappa|bavagl|seggiol/, '🍼'],
  [/sonagl|giostrin/, '🔔'], [/dinosaur/, '🦕'], [/unicorn/, '🦄'], [/gatt/, '🐱'], [/cagnol|cane\b|cani\b/, '🐶'],
  [/coniglio/, '🐰'], [/barc|nave/, '⛵'], [/aere/, '✈️'], [/cucin|pentol/, '🍳'], [/colori|pastell|pennarell|disegn/, '🖍️'],
  [/bagnett|vasch|paperell/, '🛁'], [/passeggin|carrozzin/, '👶'], [/tappet|palestrin/, '🌈']
];
const iconFor = name => { const n = String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); for (const [re, e] of ICONS) if (re.test(n)) return e; return '⭐'; };

function giftCard(it, edit, first) {
  const url = normalizeUrl(it.url);
  return `<article class="gift ${S.leaving.has(it.id) ? 'leaving' : ''}" data-gift="${esc(it.id)}">
    <div class="gh">
      <span class="script ${first ? 'first' : ''}">${first ? 'Caro Babbo Natale, vorrei…' : 'E anche…'}</span>
      ${edit ? `<button class="edit" data-action="item-menu" data-id="${esc(it.id)}" aria-label="Modifica">⋯</button>` : ''}
    </div>
    <div class="gr">
      <span class="ico" aria-hidden="true">${iconFor(it.name)}</span>
      <div class="nm">
        <h3>${esc(it.name)}</h3>
        ${url ? `<a class="shop" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Vedi su ${esc(shopOf(url))} ↗</a>` : ''}
      </div>
      <button class="take" data-action="take" data-id="${esc(it.id)}" aria-label="Lo regalo io: ${esc(it.name)}">
        <img src="img/gift.png" alt="" width="52" height="53"><span>Lo regalo io</span>
      </button>
    </div>
  </article>`;
}

/* ───────────── Fogli modali ───────────── */
let modalClose = null;
function openModal(html, onMount) {
  closeModal();
  const root = $('#modal-root');
  root.innerHTML = `<div class="backdrop"><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div></div>`;
  const bd = root.firstElementChild;
  const onKey = e => { if (e.key === 'Escape') close(); };
  const close = () => { root.innerHTML = ''; modalClose = null; document.removeEventListener('keydown', onKey); };
  bd.addEventListener('click', e => { if (e.target === bd || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', onKey);
  modalClose = close;
  onMount && onMount(bd.firstElementChild, close);
  const f = bd.querySelector('input'); if (f && matchMedia('(pointer:fine)').matches) f.focus();
}
function closeModal() { modalClose && modalClose(); }

function confirmTake(it) {
  openModal(`<h2>${esc(it.name)}</h2>
    <p class="lead">Sparirà dalla lista, così nessun altro lo sceglierà.</p>
    <div class="foot"><button class="btn btn-line" data-close>Annulla</button><button class="btn btn-red" data-ok>🎁 Lo regalo io</button></div>`,
    (el, close) => { el.querySelector('[data-ok]').onclick = () => { close(); take(it); }; });
}

async function take(it) {
  S.leaving.add(it.id); render();
  await new Promise(r => setTimeout(r, 380));
  try {
    await S.store.take(it.id);
    toast('Grazie di cuore! 🎄', 'Annulla', () => S.store.untake(it.id).catch(fail));
  } catch (e) {
    if (e.code === 'taken') toast('Qualcuno l\'ha appena scelto'); else fail(e);
  } finally { S.leaving.delete(it.id); render(); }
}

function itemForm(initial = {}) {
  openModal(`<h2>${initial.id ? 'Modifica regalo' : 'Nuovo regalo'}</h2>
    <form>
      <label class="field"><span>Regalo</span><input class="input" name="name" maxlength="140" required value="${esc(initial.name || '')}" placeholder="Es. Cavallino a dondolo in legno"></label>
      <label class="field"><span>Link al negozio</span><input class="input" name="url" inputmode="url" autocomplete="off" maxlength="1000" value="${esc(initial.url || '')}" placeholder="https://…"></label>
      <div class="foot"><button type="button" class="btn btn-line" data-close>Annulla</button><button class="btn btn-red">${initial.id ? 'Salva' : 'Aggiungi'}</button></div>
    </form>`, (el, close) => {
    el.querySelector('form').onsubmit = e => {
      e.preventDefault();
      const f = e.target, raw = f.url.value.trim(), url = normalizeUrl(raw);
      if (raw && !url) { f.url.setCustomValidity('Link non valido'); f.url.reportValidity(); f.url.oninput = () => f.url.setCustomValidity(''); return; }
      const data = { name: f.name.value.trim(), url };
      if (!data.name) return;
      close();
      (initial.id ? S.store.updateItem(initial.id, data) : S.store.addItem(data)).catch(fail);
    };
  });
}

function itemMenu(it) {
  openModal(`<h2>${esc(it.name)}</h2><div class="menu-list" style="margin-top:12px">
    <button data-m="edit">✏️ Modifica</button>
    <button data-m="del" class="danger">🗑️ Elimina</button></div>`, (el, close) => {
    el.querySelector('[data-m=edit]').onclick = () => { close(); itemForm(it); };
    el.querySelector('[data-m=del]').onclick = () => {
      close(); S.store.deleteItem(it.id).then(() => toast('Regalo eliminato')).catch(fail);
    };
  });
}

function mainMenu() {
  const link = baseUrl();
  const msg = FIRST_XMAS ? `🎄 Il primo Natale di ${CHILD_NAME}! Ecco la sua lista dei regali: ${link}` : `🎄 Natale si avvicina! Ecco la lista dei regali di ${CHILD_NAME}: ${link}`;
  openModal(`<h2>Lista di ${esc(CHILD_NAME)}</h2>
    <div class="label">Per parenti e amici</div>
    <div class="share-box"><code>${esc(link)}</code><button class="btn btn-fir btn-sm" data-copy="${esc(link)}">Copia</button></div>
    <div class="menu-list" style="margin-top:10px">
      <a class="btn btn-line btn-block" href="https://wa.me/?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">💬 Invia su WhatsApp</a>
      ${navigator.share ? `<button class="btn btn-line btn-block" data-native style="justify-content:center">📤 Altre app…</button>` : ''}
      <button data-preview>👀 Vedi come la vedono gli altri</button>
    </div>
    <div class="label">Mamma e papà</div>
    <p class="lead" style="font-size:14px;margin:0 0 8px">Dall'altro telefono basta toccare il lucchetto 🔒 e inserire la password.</p>
    <div class="menu-list">
      <button data-setpass>🔑 Cambia la password genitori</button>
      <button data-leave>🔓 Esci dall'area genitori su questo telefono</button>
    </div>`,
    (el, close) => {
      el.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => {
        try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copiato ✓'; }
        catch { const r = document.createRange(); r.selectNodeContents(b.previousElementSibling); getSelection().removeAllRanges(); getSelection().addRange(r); toast('Seleziona e copia il link'); }
      });
      const n = el.querySelector('[data-native]');
      if (n) n.onclick = async () => { try { await navigator.share({ title: `Lista regali di ${CHILD_NAME}`, text: msg }); } catch { } };
      el.querySelector('[data-preview]').onclick = () => { close(); S.preview = true; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
      el.querySelector('[data-setpass]').onclick = () => { close(); passwordForm('set'); };
      el.querySelector('[data-leave]').onclick = () => { close(); S.store.leave().then(() => toast('Sei uscita dall\'area genitori')).catch(fail); };
    });
}

// mode: 'login' (mamma/papà entrano) · 'set' (nuova password) · 'setup' (prima preparazione della lista)
function passwordForm(mode) {
  const twice = mode !== 'login';
  const title = { login: 'Area genitori', set: 'Cambia password', setup: `Prepara la lista di ${CHILD_NAME}` }[mode];
  const lead = {
    login: `Inserisci la password per aggiungere e modificare i regali di ${CHILD_NAME}.`,
    set: 'Mamma e papà la useranno per entrare dal lucchetto 🔒. Le password precedenti smettono di funzionare.',
    setup: 'Scegli la password con cui mamma e papà entreranno dal lucchetto 🔒 per gestire la lista.'
  }[mode];
  openModal(`<h2>${esc(title)}</h2><p class="lead">${esc(lead)}</p>
    <form>
      <label class="field"><span>Password</span><input class="input pin" name="p1" type="text" inputmode="numeric" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-lpignore="true" required minlength="4"></label>
      ${twice ? `<label class="field"><span>Ripeti la password</span><input class="input pin" name="p2" type="text" inputmode="numeric" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-lpignore="true" required minlength="4"></label>` : ''}
      ${mode === 'set' ? `<label class="check"><input type="checkbox" name="kick"> <span>Fai uscire anche gli altri telefoni già entrati: dovranno inserire la nuova password</span></label>` : ''}
      <p class="lead hide" data-err style="color:var(--red);margin:-4px 0 10px"></p>
      <div class="foot"><button type="button" class="btn btn-line" data-close>Annulla</button><button class="btn btn-red">${mode === 'login' ? 'Entra' : 'Conferma'}</button></div>
    </form>`, (el, close) => {
    const f = el.querySelector('form'), errBox = el.querySelector('[data-err]');
    const showErr = t => { errBox.textContent = t; errBox.classList.remove('hide'); };
    f.onsubmit = async e => {
      e.preventDefault();
      const p1 = f.p1.value.replace(/[\s\/.\-]+/g, '');
      if (p1.length < 4) return showErr('Almeno 4 caratteri.');
      if (twice && p1 !== f.p2.value.replace(/[\s\/.\-]+/g, '')) return showErr('Le due password non coincidono.');
      const btn = f.querySelector('.btn-red'); btn.disabled = true;
      try {
        const key = await hashPass(p1);
        if (mode === 'login') { await withTimeout(S.store.joinAsEditor(key), 15000); close(); toast('Benvenuti! Ora potete modificare la lista ✏️'); setTimeout(() => maybeHomeScreen(true), 1200); }
        if (mode === 'set') {
          const kick = f.kick && f.kick.checked;
          await withTimeout(S.store.changePassword(key, kick), 15000); close();
          toast(kick ? 'Password cambiata: gli altri telefoni sono usciti 🔑' : 'Password cambiata: la vecchia non funziona più 🔑');
        }
        if (mode === 'setup') {
          await S.store.setup(key); S.setupMode = false;
          try { history.replaceState(null, '', baseUrl()); } catch { }
          close(); toast('Lista pronta ✨'); render();
        }
      } catch (er) {
        btn.disabled = false;
        const code = (er && er.code) || '?';
        if (code !== 'badpass') console.error(er);
        if (code === 'rules') showErr('La nuova password funziona, ma le vecchie non sono state cancellate: vanno aggiornate le regole di Firebase.');
        else if (code === 'badpass') { showErr('Password non corretta.'); f.p1.select(); }
        else if (code === 'timeout') showErr("La connessione non risponde. Chiudi completamente l'app (scorri via dalle app aperte), riaprila e riprova.");
        else if (code.startsWith('auth:') || code.startsWith('write:')) showErr(`Il telefono non riesce ad accedere alla lista. Chiudi e riapri l'app, poi riprova. (codice: ${code})`);
        else showErr(`Connessione non riuscita, riprova tra poco. (codice: ${code})`);
      }
    };
  });
}

/* ───────────── Aggiungi alla schermata Home ───────────── */
const UA = navigator.userAgent || '';
const isIOS = /iPhone|iPad|iPod/i.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/i.test(UA);
const inAppBrowser = /FBAN|FBAV|Instagram|Line\/|; wv\)|GSA\//i.test(UA);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; });
window.addEventListener('appinstalled', () => { installEvt = null; closeModal(); toast('Fatto! La trovi sulla schermata Home 🎄'); });

const SHARE_ICON = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2f6fd6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-4px"><path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M6 11v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-8"/></svg>`;
const PLUS_ICON = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3a2b22" stroke-width="2" stroke-linecap="round" style="vertical-align:-4px"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>`;
const canOfferHome = () => S.editor && !S.preview && (isIOS || isAndroid) && !isStandalone();

function homeScreenSheet() {
  let steps;
  if (inAppBrowser) {
    steps = `<li>Tocca il menu <b>⋯</b> o <b>⋮</b> in alto a destra</li>
      <li>Scegli <b>Apri in ${isIOS ? 'Safari' : 'Chrome'}</b> (o <b>Apri nel browser</b>)</li>
      <li>Riapri questo messaggio da lì e segui i passaggi</li>`;
  } else if (isIOS) {
    steps = `<li>Tocca <b>Condividi</b> ${SHARE_ICON} ${/CriOS|FxiOS/.test(UA) ? 'in alto a destra' : 'nella barra in basso (su iPad in alto)'}</li>
      <li>Scorri e scegli <b>Aggiungi alla schermata Home</b> ${PLUS_ICON}</li>
      <li>Tocca <b>Aggiungi</b> in alto a destra</li>`;
  } else {
    steps = `<li>Tocca il menu <b>⋮</b> in alto a destra</li>
      <li>Scegli <b>Aggiungi a schermata Home</b> (o <b>Installa app</b>)</li>
      <li>Conferma con <b>Aggiungi</b> / <b>Installa</b></li>`;
  }
  openModal(`<div style="text-align:center"><img src="icons/icon-192.png" alt="" width="72" height="72" style="border-radius:18px;box-shadow:var(--shadow)"></div>
    <h2 style="text-align:center;margin-top:12px">Tienila sempre a portata di mano</h2>
    <p class="lead" style="text-align:center">Aggiungi la lista di ${esc(CHILD_NAME)} alla schermata Home: si apre come un'app ed è sempre aggiornata.</p>
    ${installEvt && !inAppBrowser ? `<button class="btn btn-red btn-block" data-install>📲 Installa sulla schermata Home</button>
      <p class="lead" style="text-align:center;font-size:13px;margin:10px 0 0">Oppure:</p>` : ''}
    <ol class="home-steps">${steps}</ol>
    <div class="foot"><button class="btn btn-line" data-close>Ho capito</button></div>`, (el, close) => {
    const i = el.querySelector('[data-install]');
    if (i) i.onclick = async () => { try { installEvt.prompt(); const r = await installEvt.userChoice; if (r.outcome === 'accepted') close(); } catch { } installEvt = null; };
  });
  ls.set(LIST_ID + '-home-seen', 1);
}
function maybeHomeScreen(force = false) {
  if (!canOfferHome() || $('#modal-root').children.length) return;
  if (!force && ls.get(LIST_ID + '-home-seen', 0)) return;
  homeScreenSheet();
}

/* ───────────── Eventi ───────────── */
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-action]');
  if (!b || b.closest('#modal-root')) return;
  const id = b.dataset.id, it = id && S.items.find(x => x.id === id);
  switch (b.dataset.action) {
    case 'menu': S.editor ? mainMenu() : passwordForm('login'); break;
    case 'add': itemForm(); break;
    case 'item-menu': if (it) itemMenu(it); break;
    case 'take': if (it) confirmTake(it); break;
    case 'untake': S.store.untake(id).catch(fail); break;
    case 'preview': S.preview = !S.preview; render(); break;
    case 'setup': passwordForm('setup'); break;
    case 'login': passwordForm('login'); break;
    case 'home': homeScreenSheet(); break;
  }
});

let toastT;
function toast(msg, actionLabel, action) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${actionLabel ? `<button>${esc(actionLabel)}</button>` : ''}`;
  t.classList.toggle('has-action', !!actionLabel);
  if (actionLabel) t.querySelector('button').onclick = () => { t.classList.remove('show'); action(); };
  t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), actionLabel ? 7000 : 2600);
}

/* ───────────── Avvio ───────────── */
async function boot() {
  render();
  try {
    S.store = firebaseConfig && firebaseConfig.apiKey ? await withTimeout(createFirebaseStore(firebaseConfig), 20000) : createLocalStore();
  } catch (e) {
    console.error(e);
    app.innerHTML = `<main><div class="empty"><div class="big">📶</div><p>Connessione non riuscita</p>
      <button class="btn btn-red" style="margin-top:12px" onclick="location.reload()">Riprova</button>
      <div class="ver">v${APP_VERSION} · ${esc((e && e.code) || 'errore')}</div></div></main>`;
    return;
  }

  // #setup: prima preparazione della lista
  if (location.hash === '#setup') S.setupMode = true;

  const timer = setTimeout(() => { if (S.list === undefined) { S.slow = true; render(); } }, 10000);
  let homeOffered = false;
  S.store.watchList(l => {
    clearTimeout(timer); S.slow = false; S.list = l; render();

  }, e => { console.error(e); S.list = null; render(); });
  S.store.watchItems(items => { S.items = items; render(); }, e => console.error(e));
  S.store.watchEditor(v => {
    S.editor = v; render();
    // il pop-up "aggiungi alla Home" lo vede solo chi gestisce la lista
    if (v && !homeOffered && !S.setupMode) { homeOffered = true; setTimeout(() => maybeHomeScreen(), 900); }
  });

  if ('serviceWorker' in navigator) {
    try {
      const hadController = !!navigator.serviceWorker.controller;
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
      const reg = await navigator.serviceWorker.register('sw.js');
      reg.update().catch(() => { });
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => { }); });
    } catch { }
  }
}
boot();
