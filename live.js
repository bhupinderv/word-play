// Woordjes live play on Firebase Realtime Database: rooms, waiting room, presence,
// host hand-over, live rounds, scoring and results. database.rules.json enforces the same limits.
const W = window.Woordjes;
const $ = s => document.querySelector(s);

const SDK = 'https://www.gstatic.com/firebasejs/12.4.0/';
const CODE_WORDS = ['KAAS', 'FIETS', 'MOLEN', 'DIJK', 'TULP', 'KLOMP', 'BROOD', 'HAVEN', 'BOOT', 'STAD',
  'BRUG', 'MELK', 'THEE', 'HOND', 'PAARD', 'VOGEL', 'ZON', 'MAAN', 'STER', 'BOS', 'ZEE', 'TREIN',
  'APPEL', 'PEER', 'TAART', 'DROP', 'WAFEL', 'KAT', 'VIS', 'REGEN'];
const WORD_OPTIONS = [10, 15, 20, 25, 30];
const MAX_SEATS = 4;
const HOST_GRACE_MS = 4000;      // a host who just reloaded gets this long to come back
const COUNTDOWN_MS = 3500;       // 3-2-1 before the first word
const REVEAL_MS = 2500;          // how long the answer stays up between words
const DROPOUT_GRACE_MS = 10000;  // fewer than 2 players online for this long ends the match

const wordId = e => e.cat + ':' + e.nl;
const BY_ID = new Map(W.ENTRIES.map(e => [wordId(e), e]));

let fb = null;    // { db, uid, d: database functions }
let room = null;  // everything about the room this tab is in
let offset = 0;   // server clock minus this device's clock
const serverNow = () => Date.now() + offset;

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
  dbMod.onValue(dbMod.ref(fb.db, '.info/serverTimeOffset'), s => { offset = s.val() || 0; });
  return fb;
}
const r = path => fb.d.ref(fb.db, path);
const isDenied = e => /permission.denied/i.test(String(e && (e.code || e.message)));
const logErr = e => console.error(e);

/* ---------- Small helpers ---------- */
const VIEWS = { join: '#liveJoin', lobby: '#liveLobby', game: '#liveGame', results: '#liveResults' };
function showView(v){
  for (const [name, sel] of Object.entries(VIEWS)) $(sel).hidden = name !== v;
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
const ordinal = n => n + (['th', 'st', 'nd', 'rd'][n] || 'th');
const fmtScore = n => n < 0 ? '−' + Math.abs(n) : String(n);
const onlineIds = d => Object.entries(d.players || {}).filter(([, p]) => p.online).map(([id]) => id);
const nameOf = (d, id) => ((d.players || {})[id] || {}).name || 'Someone';

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
    if (data.status !== 'lobby'){ showErr(`The match in ${code} has already started. Ask the host to go back to the waiting room, then join.`); return; }
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
  room = { code, data: null, unsubs: [], hostTimer: 0, tick: 0, view: null,
           phaseKey: null, sig: null, pending: -1, hostAction: null, lowSince: 0 };
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
  room.tick = setInterval(onTick, 150);
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

  const view = data.status === 'lobby' ? 'lobby' : data.status === 'finished' ? 'results' : 'game';
  if (view !== room.view){
    room.view = view;
    room.phaseKey = null; room.sig = null; room.pending = -1;
    if (view === 'game'){ room.hostAction = null; room.lowSince = 0; }
    showView(view);
  }
  if (view === 'lobby') renderLobby(data);
  else if (view === 'game') renderGame(data);
  else renderResults(data);
}

function onTick(){
  if (!room || !room.data) return;
  hostTick(room.data);
  if (room.view === 'game') renderGame(room.data);
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
    fb.d.set(r(`rooms/${room.code}/hostId`), fb.uid).catch(logErr);
  }, HOST_GRACE_MS);
}

/* ---------- Waiting room ---------- */
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

  const online = onlineIds(d).length;
  $('#lobbyNote').textContent = isHost
    ? 'Share the code or the invite link. You choose the match length and topics.'
    : `${host ? host.name : 'The host'} chooses the match length and topics.`;
  const start = $('#liveStart');
  start.hidden = !isHost;
  start.disabled = online < 2;
  $('#startNote').textContent = !isHost
    ? `Waiting for ${host ? host.name : 'the host'} to start the match.`
    : online < 2 ? 'Waiting for at least one more player.' : 'Everyone’s here. Press Start when you’re ready.';

  if (focusId){ const f = document.getElementById(focusId); if (f) f.focus(); }
}

/* ---------- Match: derived state ---------- */
const roundMs = d => ((d.settings && d.settings.seconds) || 7) * 1000;
const wordCount = d => d.wordOrder ? Object.keys(d.wordOrder).length : 0;
const entryAt = (d, i) => BY_ID.get(d.wordOrder && d.wordOrder[i]);
function answersFor(d, i){
  const x = (d.rounds && d.rounds[i]) || {};
  return { correct: x.correct || {}, wrong: x.wrong || {} };
}
// Points by order of correct answers (server time): n-1, n-2, ... Wrong answers: -1.
function placings(d, i){
  const { correct, wrong } = answersFor(d, i);
  const n = d.playersAtStart || 2;
  const res = {};
  Object.entries(correct)
    .sort((a, b) => (a[1] - b[1]) || (a[0] < b[0] ? -1 : 1))
    .forEach(([id], k) => { res[id] = { place: k + 1, pts: Math.max(0, n - 1 - k) }; });
  Object.keys(wrong).forEach(id => { res[id] = { wrong: true, pts: -1 }; });
  return res;
}
function totals(d){
  const t = {};
  Object.keys(d.players || {}).forEach(id => { t[id] = { score: 0, correct: 0, wrong: 0 }; });
  Object.keys(d.rounds || {}).forEach(i => {
    for (const [id, x] of Object.entries(placings(d, i))){
      if (!t[id]) continue; // player has left the room
      t[id].score += x.pts;
      if (x.wrong) t[id].wrong++; else t[id].correct++;
    }
  });
  return t;
}
function allDone(d, i){
  const { correct, wrong } = answersFor(d, i);
  const online = onlineIds(d);
  return online.length > 0 && online.every(id => correct[id] || wrong[id]);
}
function playedCount(d){
  if (!d.round) return 0;
  return d.round.startedAt <= serverNow() ? d.round.index + 1 : d.round.index;
}
function phase(d){
  const rd = d.round;
  if (!rd) return { kind: 'countdown', left: COUNTDOWN_MS };
  const now = serverNow();
  if (now < rd.startedAt){
    return rd.index === 0 ? { kind: 'countdown', left: rd.startedAt - now } : { kind: 'reveal', i: rd.index - 1 };
  }
  const i = rd.index, elapsed = now - rd.startedAt;
  if (elapsed >= roundMs(d) || allDone(d, i)) return { kind: 'reveal', i, ended: true };
  return { kind: 'answer', i, left: roundMs(d) - elapsed };
}

/* ---------- Match: the host keeps it moving ---------- */
async function startMatch(){
  const d = room && room.data;
  if (!d || d.hostId !== fb.uid) return;
  const online = onlineIds(d).length;
  if (online < 2){ toast('You need at least 2 players online.'); return; }
  const s = d.settings || {};
  const topics = new Set(Object.values(s.topics || {}));
  const pool = W.ENTRIES.filter(e => topics.has(e.cat));
  if (!pool.length){ toast('Pick at least one topic.'); return; }
  const order = [];
  while (order.length < s.words){
    const batch = W.shuffle(pool.slice());
    if (order.length && batch.length > 1 && batch[0] === order[order.length - 1]) batch.push(batch.shift());
    order.push(...batch);
  }
  room.hostAction = null; room.lowSince = 0;
  try {
    await fb.d.update(r('rooms/' + room.code), {
      status: 'playing',
      playersAtStart: Math.min(MAX_SEATS, online),
      wordOrder: order.slice(0, s.words).map(wordId),
      round: { index: 0, startedAt: serverNow() + COUNTDOWN_MS },
      rounds: null
    });
  } catch (e) {
    console.error(e);
    toast('Couldn’t start the match. Try again.');
  }
}

function hostTick(d){
  if (d.hostId !== fb.uid || d.status !== 'playing'){ room.lowSince = 0; return; }
  const status = r(`rooms/${room.code}/status`);

  // Fewer than 2 players online for a while: the match ends.
  if (onlineIds(d).length < 2){
    if (!room.lowSince) room.lowSince = Date.now();
    if (Date.now() - room.lowSince >= DROPOUT_GRACE_MS && room.hostAction !== 'end'){
      room.hostAction = 'end';
      fb.d.set(status, 'finished').catch(logErr);
    }
  } else room.lowSince = 0;

  const ph = phase(d);
  if (ph.kind !== 'reveal' || !ph.ended) return; // act only once the current word has ended
  const i = d.round.index, key = 'adv-' + i;
  if (room.hostAction === key || room.hostAction === 'end') return;
  room.hostAction = key;
  if (i + 1 >= wordCount(d)){
    setTimeout(() => {
      const now = room && room.data;
      if (now && now.status === 'playing' && now.round && now.round.index === i) fb.d.set(status, 'finished').catch(logErr);
    }, REVEAL_MS);
  } else {
    fb.d.set(r(`rooms/${room.code}/round`), { index: i + 1, startedAt: serverNow() + REVEAL_MS }).catch(logErr);
  }
}

/* ---------- Match: what each player sees ---------- */
function setTile(cat, art, word, gloss){
  $('#lgCat').textContent = cat;
  $('#lgArt').textContent = art;
  $('#lgWord').textContent = word; W.fitWord($('#lgWord'), word);
  $('#lgGloss').textContent = gloss;
  $('#lgGloss').classList.toggle('show', !!gloss);
}

function enterPhase(d, ph){
  const tile = $('#lgTile'), input = $('#lgInput'), check = $('#lgCheck');
  tile.classList.remove('good', 'bad', 'shake', 'enter');
  if (ph.kind === 'countdown'){
    setTile('Get ready', '', '3', '');
    input.value = ''; input.disabled = true; check.disabled = true;
    $('#lgFeed').textContent = 'The first word appears in a moment.';
    return;
  }
  const e = entryAt(d, ph.i);
  if (!e) return;
  const mine = placings(d, ph.i)[fb.uid];
  if (ph.kind === 'answer'){
    setTile(W.CAT_BY_ID[e.cat].nl, e.art, e.nl, '');
    void tile.offsetWidth; tile.classList.add('enter');
    const done = !!mine || room.pending === ph.i;
    input.value = ''; input.disabled = done; check.disabled = done;
    if (!done) input.focus();
    $('#lgFeed').textContent = '';
  } else {
    setTile(W.CAT_BY_ID[e.cat].nl, e.art, e.nl, e.en.slice(0, 3).join(' · '));
    if (mine) tile.classList.add(mine.wrong ? 'bad' : 'good');
    input.disabled = true; check.disabled = true;
  }
}

function renderGame(d){
  const ph = phase(d);
  const total = wordCount(d);
  const box = $('#lgRoundBox'), bar = $('#lgBar');
  if (ph.kind === 'countdown'){
    $('#lgRound').textContent = 'Get ready';
    bar.style.width = '100%';
    box.classList.remove('warn');
  } else {
    $('#lgRound').textContent = `Word ${Math.min(ph.i + 1, total)} of ${total}`;
    const left = ph.kind === 'answer' ? ph.left : 0;
    bar.style.width = (left / roundMs(d) * 100) + '%';
    box.classList.toggle('warn', ph.kind === 'answer' && left <= 2000);
  }
  const key = ph.kind + ':' + (ph.kind === 'countdown' ? '' : ph.i);
  if (key !== room.phaseKey){ room.phaseKey = key; room.sig = null; enterPhase(d, ph); }
  if (ph.kind === 'countdown'){
    const n = String(Math.min(3, Math.max(1, Math.ceil(ph.left / 1000))));
    if ($('#lgWord').textContent !== n){ $('#lgWord').textContent = n; W.fitWord($('#lgWord'), n); }
  }
  renderBoard(d, ph);
}

function renderBoard(d, ph){
  const players = d.players || {};
  const t = totals(d);
  const i = ph.kind === 'countdown' ? -1 : ph.i;
  const pl = i >= 0 ? placings(d, i) : {};
  const sig = JSON.stringify([ph.kind, i, pl, t, Object.entries(players).map(([id, p]) => [id, p.online])]);
  if (sig === room.sig) return;
  room.sig = sig;

  const ids = Object.keys(players).sort((a, b) => (t[b].score - t[a].score) || players[a].name.localeCompare(players[b].name));
  $('#lgBoard').innerHTML = ids.map(id => {
    const p = players[id], x = pl[id];
    let mark = '';
    if (x) mark = x.wrong ? '<span class="mk bad">✗ −1</span>' : `<span class="mk good">${ordinal(x.place)} +${x.pts}</span>`;
    else if (ph.kind === 'answer') mark = '<span class="mk">…</span>';
    else if (ph.kind === 'reveal') mark = '<span class="mk">no answer</span>';
    else mark = '<span class="mk"></span>';
    return `<li class="bp${id === fb.uid ? ' me' : ''}${p.online ? '' : ' off'}"><span class="nm">${W.esc(p.name)}${id === fb.uid ? ' (you)' : ''}</span><span class="sc">${fmtScore(t[id].score)}</span>${mark}</li>`;
  }).join('');

  const feed = $('#lgFeed');
  if (ph.kind === 'answer'){
    const mine = pl[fb.uid];
    if (mine) feed.textContent = mine.wrong ? 'Fout. You’re locked out for this word (−1).' : `Juist! You’re ${ordinal(mine.place)} (+${mine.pts}).`;
  } else if (ph.kind === 'reveal'){
    const got = Object.entries(pl).filter(([, x]) => !x.wrong).sort((a, b) => a[1].place - b[1].place)
      .map(([id, x]) => `${nameOf(d, id)} ${ordinal(x.place)} +${x.pts}`);
    const missed = Object.entries(pl).filter(([, x]) => x.wrong).map(([id]) => `${nameOf(d, id)} −1`);
    feed.textContent = got.length || missed.length ? [...got, ...missed].join(' · ') : 'Nobody got this one.';
  }
}

$('#lgForm').addEventListener('submit', async e => {
  e.preventDefault();
  const d = room && room.data;
  if (!d || d.status !== 'playing') return;
  const ph = phase(d);
  if (ph.kind !== 'answer') return;
  const i = ph.i;
  const { correct, wrong } = answersFor(d, i);
  if (correct[fb.uid] || wrong[fb.uid] || room.pending === i) return;
  const input = $('#lgInput');
  const v = input.value.trim();
  if (!v){ input.classList.remove('nudge'); void input.offsetWidth; input.classList.add('nudge'); input.focus(); return; }
  const ok = W.grade(v, entryAt(d, i)).ok;
  room.pending = i;
  input.disabled = true; $('#lgCheck').disabled = true;
  const tile = $('#lgTile');
  tile.classList.remove('enter');
  tile.classList.add(ok ? 'good' : 'bad');
  if (!ok){ void tile.offsetWidth; tile.classList.add('shake'); }
  $('#lgFeed').textContent = ok ? 'Juist! Checking your place…' : 'Fout.';
  try {
    await fb.d.set(r(`rooms/${room.code}/rounds/${i}/${ok ? 'correct' : 'wrong'}/${fb.uid}`), fb.d.serverTimestamp());
  } catch (err) {
    if (isDenied(err)) $('#lgFeed').textContent = 'Too late: time was up for that word.';
    else { console.error(err); $('#lgFeed').textContent = 'Your answer didn’t reach the server.'; }
  }
});

/* ---------- Results ---------- */
function renderResults(d){
  const players = d.players || {};
  const t = totals(d);
  const rows = Object.keys(players).map(id => ({ id, name: players[id].name, ...t[id] }))
    .sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name));
  rows.forEach(x => { x.place = 1 + rows.filter(o => o.score > x.score).length; });
  const winners = rows.filter(x => x.place === 1);
  const total = wordCount(d), played = playedCount(d);

  if (winners.length > 1){
    $('#lrTitle').textContent = 'Gelijkspel!';
    $('#lrSub').textContent = `A tie between ${winners.map(w => w.name).join(' and ')}.`;
  } else if (winners[0] && winners[0].id === fb.uid){
    $('#lrTitle').textContent = 'Gewonnen!';
    $('#lrSub').textContent = 'You won the match.';
  } else {
    $('#lrTitle').textContent = `${winners[0] ? winners[0].name : 'Niemand'} wint!`;
    $('#lrSub').textContent = `${winners[0] ? winners[0].name : 'Nobody'} won the match.`;
  }
  $('#lrSub').textContent += played < total
    ? ` The match ended after ${played} of ${total} words because fewer than 2 players were left.`
    : ` ${total} words, ${d.playersAtStart || rows.length} players.`;

  $('#lrRanking').innerHTML = rows.map(x =>
    `<li class="rank${x.place === 1 ? ' first' : ''}"><span class="pl">${x.place}</span>`
    + `<span class="nm">${W.esc(x.name)}${x.id === fb.uid ? '<small>you</small>' : ''}</span>`
    + `<span class="sc">${fmtScore(x.score)}</span>`
    + `<span class="st">${x.correct} correct · ${x.wrong} wrong</span></li>`).join('');

  const missed = [];
  for (let i = 0; i < played; i++){
    const e = entryAt(d, i);
    if (e && !Object.keys(answersFor(d, i).correct).length) missed.push(e);
  }
  $('#lrMissed').innerHTML = missed.length
    ? '<table><thead><tr><th>Dutch</th><th>Meaning</th></tr></thead><tbody>'
      + missed.map(e => `<tr><td class="nl" lang="nl">${e.art ? `<small>${e.art}</small>` : ''}${W.esc(e.nl)}</td><td>${W.esc(e.en.slice(0, 3).join(', '))}</td></tr>`).join('')
      + '</tbody></table>'
    : '<p class="clean">Every word was answered correctly by someone.</p>';

  const isHost = d.hostId === fb.uid;
  const online = onlineIds(d).length;
  $('#lrRematch').hidden = !isHost;
  $('#lrLobby').hidden = !isHost;
  $('#lrRematch').disabled = online < 2;
  $('#lrNote').textContent = !isHost
    ? `Waiting for ${nameOf(d, d.hostId)} to start a rematch.`
    : online < 2 ? 'A rematch needs at least 2 players online.' : 'Same players and settings. New players can join from the waiting room.';
}

function backToLobby(){
  const d = room && room.data;
  if (!d || d.hostId !== fb.uid) return;
  fb.d.update(r('rooms/' + room.code), { status: 'lobby', round: null, rounds: null, wordOrder: null, playersAtStart: null })
    .catch(e => { console.error(e); toast('Couldn’t go back to the waiting room.'); });
}

/* ---------- Leaving ---------- */
function stopListening(){
  if (!room) return;
  room.unsubs.forEach(u => u());
  clearTimeout(room.hostTimer);
  clearInterval(room.tick);
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
$('#liveStart').addEventListener('click', startMatch);
$('#lrRematch').addEventListener('click', startMatch);
$('#lrLobby').addEventListener('click', backToLobby);
['#leaveBtn', '#lgLeave', '#lrLeave'].forEach(sel => $(sel).addEventListener('click', leaveRoom));
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
