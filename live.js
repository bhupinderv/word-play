// Woordjes live play: rooms, waiting room, presence and host hand-over on
// Firebase Realtime Database. The rules in database.rules.json enforce the same limits.
const W = window.Woordjes;
const $ = s => document.querySelector(s);

const SDK = 'https://www.gstatic.com/firebasejs/12.4.0/';
const CODE_WORDS = ['KAAS', 'FIETS', 'MOLEN', 'DIJK', 'TULP', 'KLOMP', 'BROOD', 'HAVEN', 'BOOT', 'STAD',
  'BRUG', 'MELK', 'THEE', 'HOND', 'PAARD', 'VOGEL', 'ZON', 'MAAN', 'STER', 'BOS', 'ZEE', 'TREIN',
  'APPEL', 'PEER', 'TAART', 'DROP', 'WAFEL', 'KAT', 'VIS', 'REGEN'];
const WORD_OPTIONS = [10, 15, 20, 25, 30];
const MAX_SEATS = 4;
const HOST_GRACE_MS = 4000; // lets a host who just reloaded come back before anyone takes over

let fb = null;   // { db, uid, d: database functions }
let room = null; // { code, data, unsubs, hostTimer }

/* ---------- Firebase connection (loaded only when someone plays live) ---------- */
async function connect(){
  if (fb) return fb;
  let cfg, appMod, authMod, dbMod;
  try { cfg = await import('./firebase-config.js'); }
  catch (e) { throw Object.assign(new Error('missing-config'), { cause: e }); }
  try {
    [appMod, authMod, dbMod] = await Promise.all([
      import(SDK + 'firebase-app.js'),
      import(SDK + 'firebase-auth.js'),
      import(SDK + 'firebase-database.js')
    ]);
  } catch (e) { throw Object.assign(new Error('sdk-failed'), { cause: e }); }
  const app = appMod.initializeApp(cfg.firebaseConfig);
  // Per-tab identity: a reload keeps you in your room, and two tabs count as two players.
  const auth = authMod.initializeAuth(app, { persistence: authMod.browserSessionPersistence });
  await auth.authStateReady();
  if (!auth.currentUser) await authMod.signInAnonymously(auth);
  fb = { db: dbMod.getDatabase(app), uid: auth.currentUser.uid, d: dbMod };
  return fb;
}
const r = path => fb.d.ref(fb.db, path);
const isDenied = e => /permission.denied/i.test(String(e && (e.code || e.message)));

/* ---------- Small UI helpers ---------- */
function showView(v){
  $('#liveJoin').hidden = v !== 'join';
  $('#liveLobby').hidden = v !== 'lobby';
  W.show('live');
}
function showErr(msg){ $('#joinErr').textContent = msg; }
function busy(on){
  $('#createBtn').disabled = on;
  $('#joinBtn').disabled = on;
  $('#createBtn').textContent = on ? 'Connecting…' : 'Create a room';
}
let toastTimer = 0;
function toast(msg){
  let t = $('#toast');
  if (!t){
    t = document.createElement('div');
    t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status');
    document.body.appendChild(t);
  }
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
}
function readName(){
  const v = $('#liveName').value.trim().replace(/\s+/g, ' ');
  if (!v || v.length > 20){
    showErr('Enter your name (up to 20 characters) first.');
    $('#liveName').focus();
    return null;
  }
  W.store.set('woordjes.liveName', v);
  return v;
}
function normCode(s){
  const m = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').match(/^([A-Z]{3,5})([0-9]{2})$/);
  return m ? m[1] + '-' + m[2] : '';
}
const randomCode = () => CODE_WORDS[Math.floor(Math.random() * CODE_WORDS.length)] + '-' + (10 + Math.floor(Math.random() * 90));
const inviteUrl = code => location.origin + location.pathname + '?room=' + code;

function connectError(e){
  console.error(e);
  const code = String((e && e.code) || '');
  const kind = String((e && e.message) || '');
  let msg;
  if (!navigator.onLine || code === 'auth/network-request-failed')
    msg = 'Live play needs an internet connection. Check your connection and try again.';
  else if (kind === 'missing-config')
    msg = 'This site is missing firebase-config.js. Upload it next to index.html, then reload the page.';
  else if (kind === 'sdk-failed')
    msg = 'Couldn’t load the Firebase library from Google. Reload the page, or try another network.';
  else if (code === 'auth/operation-not-allowed' || code === 'auth/admin-restricted-operation')
    msg = 'Live play isn’t switched on yet: enable Anonymous sign-in in Firebase (Authentication → Sign-in method).';
  else if (isDenied(e))
    msg = 'The live server refused that request. Try again, or create a new room.';
  else if (kind === 'no-code')
    msg = 'Couldn’t find a free room code. Try again.';
  else
    msg = `Couldn’t reach the live server (${code || kind || 'unknown error'}). Try again in a moment.`;
  showErr(msg);
}

/* ---------- Create and join ---------- */
async function createRoom(){
  showErr('');
  const name = readName(); if (!name) return;
  busy(true);
  try {
    await connect();
    for (let i = 0; i < 6; i++){
      const code = randomCode();
      try {
        await fb.d.set(r('rooms/' + code), {
          hostId: fb.uid,
          status: 'lobby',
          createdAt: fb.d.serverTimestamp(),
          settings: { words: 15, seconds: 7, topics: W.CATS.map(c => c.id) },
          seats: { 0: fb.uid },
          players: { [fb.uid]: { name, online: true, joinedAt: fb.d.serverTimestamp(), seat: 0 } }
        });
        enterRoom(code);
        return;
      } catch (e) {
        if (!isDenied(e)) throw e; // code already in use: try another
      }
    }
    throw new Error('no-code');
  } catch (e) {
    connectError(e);
  } finally {
    busy(false);
  }
}

async function joinRoom(raw){
  showErr('');
  const name = readName(); if (!name) return;
  const code = normCode(raw);
  if (!code){ showErr('Room codes look like KAAS-42.'); $('#liveCode').focus(); return; }
  $('#liveCode').value = code;
  busy(true);
  try {
    await connect();
    const snap = await fb.d.get(r('rooms/' + code));
    if (!snap.exists()){ showErr(`There’s no room ${code}. Check the code with your friend.`); return; }
    const data = snap.val();
    const players = data.players || {};

    if (players[fb.uid]){ // back after a reload
      await fb.d.set(r(`rooms/${code}/players/${fb.uid}/online`), true);
      enterRoom(code);
      return;
    }
    if (data.status !== 'lobby'){ showErr(`The match in ${code} has already started. Ask the host for a rematch invite.`); return; }
    if (Object.values(players).some(p => p.name.trim().toLowerCase() === name.toLowerCase())){
      showErr(`Someone in ${code} is already called ${name}. Pick another name.`);
      return;
    }
    for (let n = 0; n < MAX_SEATS; n++){
      if (data.seats && data.seats[n]) continue;
      try {
        await fb.d.update(r('rooms/' + code), {
          ['seats/' + n]: fb.uid,
          ['players/' + fb.uid]: { name, online: true, joinedAt: fb.d.serverTimestamp(), seat: n }
        });
        enterRoom(code);
        return;
      } catch (e) {
        if (!isDenied(e)) throw e; // someone took this seat a moment ago: try the next
      }
    }
    showErr(`Room ${code} is full (4 players).`);
  } catch (e) {
    connectError(e);
  } finally {
    busy(false);
  }
}

/* ---------- In the room ---------- */
function enterRoom(code){
  stopListening();
  room = { code, data: null, unsubs: [], hostTimer: 0 };
  history.replaceState(null, '', '?room=' + code);
  const myOnline = r(`rooms/${code}/players/${fb.uid}/online`);

  // Online dot: marked offline by the server the moment this device disconnects.
  room.unsubs.push(fb.d.onValue(r('.info/connected'), s => {
    const on = s.val() === true;
    $('#connNote').hidden = on;
    if (on) fb.d.onDisconnect(myOnline).set(false).then(() => fb.d.set(myOnline, true)).catch(() => {});
  }));
  room.unsubs.push(fb.d.onValue(r('rooms/' + code), s => onRoom(s.val()), e => {
    console.error(e);
    exitToJoin('Lost access to the room.');
  }));
  $('#roomCode').textContent = code;
  showView('lobby');
}

function onRoom(data){
  if (!room) return;
  if (!data){ exitToJoin('The room was closed.'); return; }
  const players = data.players || {};
  if (!players[fb.uid]){ exitToJoin('You’re no longer in this room.'); return; }

  const prev = room.data;
  room.data = data;
  if (prev){
    const before = prev.players || {};
    for (const [id, p] of Object.entries(before)) if (!players[id] && id !== fb.uid) toast(`${p.name} left`);
    for (const [id, p] of Object.entries(players)) if (!before[id] && id !== fb.uid) toast(`${p.name} joined`);
    if (prev.hostId !== data.hostId && data.hostId === fb.uid) toast('You’re the host now');
  }
  checkHost(data);
  renderLobby(data);
}

// If the host is gone or offline, the longest-connected online player takes over.
function checkHost(data){
  clearTimeout(room.hostTimer);
  const players = data.players || {};
  const host = players[data.hostId];
  if (host && host.online) return;
  const next = Object.entries(players)
    .filter(([, p]) => p.online)
    .sort((a, b) => (a[1].joinedAt - b[1].joinedAt) || (a[0] < b[0] ? -1 : 1))[0];
  if (!next || next[0] !== fb.uid) return;
  room.hostTimer = setTimeout(() => {
    const d = room && room.data;
    if (!d) return;
    const h = (d.players || {})[d.hostId];
    if (h && h.online) return;
    fb.d.set(r(`rooms/${room.code}/hostId`), fb.uid).catch(e => console.error(e));
  }, HOST_GRACE_MS);
}

function renderLobby(d){
  const players = d.players || {};
  const isHost = d.hostId === fb.uid;
  const host = players[d.hostId];
  const focusId = document.activeElement && document.activeElement.id;

  let seats = '';
  for (let n = 0; n < MAX_SEATS; n++){
    const id = d.seats && d.seats[n];
    const p = id && players[id];
    if (!p){ seats += '<div class="seat empty"><span>Open seat</span><span>Waiting for a player…</span></div>'; continue; }
    seats += `<div class="seat"><span class="nm">${W.esc(p.name)}</span>`
      + `<span class="dot${p.online ? '' : ' off'}">${p.online ? 'Online' : 'Offline'}</span>`
      + `<span class="tags">${id === d.hostId ? '<span class="tag host">Host</span>' : ''}${id === fb.uid ? '<span class="tag">You</span>' : ''}</span></div>`;
  }
  $('#seats').innerHTML = seats;

  const s = d.settings || {};
  const topics = new Set(s.topics ? Object.values(s.topics) : []);
  $('#liveWords').innerHTML = WORD_OPTIONS.map(v =>
    `<label class="opt"><input type="radio" name="liveWords" id="lw-${v}" value="${v}"${s.words === v ? ' checked' : ''}${isHost ? '' : ' disabled'}><span class="pill">${v} words</span></label>`).join('');
  $('#liveTopics').innerHTML = W.CATS.map(c =>
    `<label class="opt"><input type="checkbox" id="lt-${c.id}" value="${c.id}"${topics.has(c.id) ? ' checked' : ''}${isHost ? '' : ' disabled'}><span class="chip">${c.en}<span class="n">${c.count}</span></span></label>`).join('');

  const online = Object.values(players).filter(p => p.online).length;
  $('#lobbyNote').textContent = isHost
    ? 'Share the code or the invite link. You choose the match length and topics.'
    : `${host ? host.name : 'The host'} chooses the match length and topics.`;
  const start = $('#liveStart');
  start.hidden = !isHost;
  start.disabled = true; // live rounds arrive in the next build step
  $('#startNote').textContent = !isHost
    ? `Waiting for ${host ? host.name : 'the host'} to start the match.`
    : online < 2
      ? 'Waiting for at least one more player.'
      : 'Everyone’s here. Live rounds are the next build step, so Start is switched off for now.';

  if (focusId){ const f = document.getElementById(focusId); if (f) f.focus(); }
}

function stopListening(){
  if (!room) return;
  room.unsubs.forEach(u => u());
  clearTimeout(room.hostTimer);
  fb.d.onDisconnect(r(`rooms/${room.code}/players/${fb.uid}/online`)).cancel().catch(() => {});
  room = null;
}
function exitToJoin(msg){
  stopListening();
  history.replaceState(null, '', location.pathname);
  showView('join');
  if (msg) toast(msg);
}

async function leaveRoom(){
  if (!room) return;
  const { code, data } = room;
  const players = (data && data.players) || {};
  const me = players[fb.uid];
  exitToJoin('You left the room.');
  try {
    const others = Object.keys(players).filter(id => id !== fb.uid);
    if (data && data.hostId === fb.uid && others.length === 0) await fb.d.remove(r('rooms/' + code));
    else if (me) await fb.d.update(r('rooms/' + code), { ['seats/' + me.seat]: null, ['players/' + fb.uid]: null });
  } catch (e) {
    console.error(e);
  }
}

/* ---------- Host settings ---------- */
$('#liveWords').addEventListener('change', e => {
  if (!room || room.data.hostId !== fb.uid) return;
  fb.d.set(r(`rooms/${room.code}/settings/words`), Number(e.target.value)).catch(err => { console.error(err); toast('Couldn’t change the match length.'); });
});
$('#liveTopics').addEventListener('change', e => {
  if (!room || room.data.hostId !== fb.uid) return;
  const topics = [...$('#liveTopics').querySelectorAll('input:checked')].map(i => i.value);
  if (!topics.length){ e.target.checked = true; toast('Keep at least one topic.'); return; }
  fb.d.set(r(`rooms/${room.code}/settings/topics`), topics).catch(err => { console.error(err); toast('Couldn’t change the topics.'); });
});

/* ---------- Buttons ---------- */
$('#friendsBtn').addEventListener('click', () => { showErr(''); showView('join'); $('#liveName').focus(); });
$('#liveBack').addEventListener('click', () => W.show('setup'));
$('#createBtn').addEventListener('click', createRoom);
$('#joinBtn').addEventListener('click', () => joinRoom($('#liveCode').value));
$('#liveCode').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom($('#liveCode').value); });
$('#leaveBtn').addEventListener('click', leaveRoom);
$('#shareBtn').addEventListener('click', async () => {
  if (!room) return;
  const url = inviteUrl(room.code);
  if (navigator.share){
    try { await navigator.share({ title: 'Woordjes', text: `Join my Woordjes room ${room.code}`, url }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('Invite link copied'); }
  catch { window.prompt('Copy this invite link:', url); }
});

/* ---------- Opening an invite link (or reloading inside a room) ---------- */
$('#liveName').value = W.store.get('woordjes.liveName') || '';
const invited = normCode(new URLSearchParams(location.search).get('room'));
if (invited){
  $('#liveCode').value = invited;
  showView('join');
  if ($('#liveName').value) joinRoom(invited);
  else { showErr(`Enter your name, then press Join to enter room ${invited}.`); $('#liveName').focus(); }
}
