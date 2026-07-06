import { Game } from './game.js';
import { Net } from './network.js';
import { initAudio } from './audio.js';

const $ = (id) => document.getElementById(id);

const el = {
  app: $('app'),
  hud: $('hud'),
  score: $('score'),
  msg: $('msg'),
  menu: $('menu'),
  menuStatus: $('menu-status'),
  playerName: $('player-name'),
  nameId: $('name-id'),
  btnSingle: $('btn-single'),
  btnQuick: $('btn-quick'),
  btnRoom: $('btn-room'),
  roomMenu: $('room-menu'),
  roomStatus: $('room-status'),
  btnCreate: $('btn-create'),
  btnJoin: $('btn-join'),
  joinCode: $('join-code'),
  btnRoomBack: $('btn-room-back'),
  end: $('end'),
  endTitle: $('end-title'),
  btnRematch: $('btn-rematch'),
  btnMenu: $('btn-menu'),
  pause: $('pause'),
  btnResume: $('btn-resume'),
  btnPauseMenu: $('btn-pause-menu'),
};

let game = null;
let pendingNet = null;
let msgTimer = null;

// --- Oyuncu kimliği: kalıcı benzersiz ID + isim ---
function getPlayerId() {
  let id = null;
  try { id = localStorage.getItem('kv_pid'); } catch (e) { /* localStorage yoksa */ }
  if (!id) {
    id = 'P-' + Math.random().toString(36).slice(2, 8).toUpperCase() +
         Date.now().toString(36).slice(-4).toUpperCase();
    try { localStorage.setItem('kv_pid', id); } catch (e) { /* yok say */ }
  }
  return id;
}
const PLAYER_ID = getPlayerId();
el.nameId.textContent = 'ID: ' + PLAYER_ID;

try {
  const saved = localStorage.getItem('kv_name');
  if (saved) el.playerName.value = saved;
} catch (e) { /* yok say */ }

// İsim zorunlu — geçerliyse döndür, değilse kutuyu kırmızı yak
function requireName() {
  const name = el.playerName.value.trim();
  if (name.length < 1) {
    el.playerName.classList.add('invalid');
    el.playerName.focus();
    setMenuStatus('⚠️ Önce bir isim gir!');
    return null;
  }
  el.playerName.classList.remove('invalid');
  try { localStorage.setItem('kv_name', name); } catch (e) { /* yok say */ }
  return name.slice(0, 12);
}

const ui = {
  updateScore(scores) {
    el.score.textContent = `${scores[0]} — ${scores[1]}`;
  },
  showMsg(text, dur = 2000) {
    el.msg.textContent = text;
    el.msg.classList.remove('hidden');
    el.msg.style.animation = 'none';
    void el.msg.offsetWidth;
    el.msg.style.animation = '';
    if (msgTimer) clearTimeout(msgTimer);
    msgTimer = setTimeout(() => el.msg.classList.add('hidden'), dur);
  },
  showEnd(text, scores) {
    el.endTitle.textContent = `${text}\n${scores[0]} — ${scores[1]}`;
    el.endTitle.style.whiteSpace = 'pre-line';
    el.end.classList.remove('hidden');
  },
  hideEnd() { el.end.classList.add('hidden'); },
  showPause() { el.pause.classList.remove('hidden'); },
  hidePause() { el.pause.classList.add('hidden'); },
};

function setMenuStatus(html) { el.menuStatus.innerHTML = html; }
function setRoomStatus(html) { el.roomStatus.innerHTML = html; }

function startGame(mode, net, opts = {}) {
  initAudio();
  el.menu.classList.add('hidden');
  el.roomMenu.classList.add('hidden');
  el.hud.classList.remove('hidden');
  ui.hideEnd();
  ui.hidePause();
  game = new Game({
    mode, net, ui, container: el.app,
    myName: opts.myName || requireName() || 'Oyuncu',
    oppName: opts.oppName || 'RAKİP',
  });
  game.onExit = backToMenu;
  game.start();
  window.__game = game; // hata ayıklama için
}

function backToMenu() {
  if (game) {
    game.dispose();
    game = null;
    window.__game = null;
  }
  if (pendingNet) { pendingNet.dispose(); pendingNet = null; }
  el.hud.classList.add('hidden');
  el.roomMenu.classList.add('hidden');
  ui.hideEnd();
  ui.hidePause();
  el.menu.classList.remove('hidden');
  setMenuStatus('');
  setRoomStatus('');
  setMenuButtonsEnabled(true);
}

function setMenuButtonsEnabled(on) {
  el.btnSingle.disabled = !on;
  el.btnQuick.disabled = !on;
  el.btnRoom.disabled = !on;
}

// ---------- Singleplayer ----------
el.btnSingle.addEventListener('click', () => {
  const name = requireName();
  if (!name) return;
  startGame('single', null, { myName: name, oppName: 'BOT' });
});

// ---------- Hızlı Eşleşme ----------
el.btnQuick.addEventListener('click', async () => {
  const name = requireName();
  if (!name) return;
  initAudio();
  setMenuButtonsEnabled(false);
  setMenuStatus('Rakip aranıyor… <button id="btn-cancel-quick" class="cancel-link">İptal</button>');
  $('btn-cancel-quick').addEventListener('click', backToMenu);
  try {
    pendingNet = new Net();
    pendingNet.onMatched = (d) => {
      const net = pendingNet;
      pendingNet = null;
      startGame(d.isHost ? 'host' : 'guest', net, { myName: name, oppName: d.peerName || 'RAKİP' });
    };
    pendingNet.onDisconnected = () => failMenu('⚠️ Bağlantı koptu!');
    const res = await pendingNet.quickMatch(name, PLAYER_ID);
    if (!res.queued) {
      // Anında eşleşme 'matched' olayıyla gelir; burada bekle
    }
  } catch (e) {
    failMenu('⚠️ Sunucuya ulaşılamadı!');
  }
});

function failMenu(text) {
  if (pendingNet) { pendingNet.dispose(); pendingNet = null; }
  setMenuStatus(text);
  setMenuButtonsEnabled(true);
}

// ---------- Arkadaşınla Oda ----------
el.btnRoom.addEventListener('click', () => {
  if (!requireName()) return;
  el.menu.classList.add('hidden');
  el.roomMenu.classList.remove('hidden');
  setRoomStatus('');
  setRoomButtonsEnabled(true);
});

el.btnRoomBack.addEventListener('click', () => {
  if (pendingNet) { pendingNet.dispose(); pendingNet = null; }
  el.roomMenu.classList.add('hidden');
  el.menu.classList.remove('hidden');
  setRoomStatus('');
  setMenuButtonsEnabled(true);
});

function setRoomButtonsEnabled(on) {
  el.btnCreate.disabled = !on;
  el.btnJoin.disabled = !on;
}

el.btnCreate.addEventListener('click', async () => {
  const name = requireName();
  if (!name) return;
  initAudio();
  setRoomButtonsEnabled(false);
  setRoomStatus('Oda kuruluyor…');
  try {
    pendingNet = new Net();
    const code = await pendingNet.createRoom(name, PLAYER_ID);
    setRoomStatus(`Oda kodu:<span class="room-code">${code}</span>Arkadaşın bekleniyor…`);
    pendingNet.onPeerJoined = (d) => {
      const net = pendingNet;
      pendingNet = null;
      startGame('host', net, { myName: name, oppName: (d && d.name) || 'RAKİP' });
    };
    pendingNet.onDisconnected = () => {
      if (pendingNet) { pendingNet.dispose(); pendingNet = null; }
      setRoomStatus('⚠️ Bağlantı koptu!');
      setRoomButtonsEnabled(true);
    };
  } catch (e) {
    setRoomStatus('⚠️ Oda kurulamadı!');
    if (pendingNet) { pendingNet.dispose(); pendingNet = null; }
    setRoomButtonsEnabled(true);
  }
});

el.btnJoin.addEventListener('click', async () => {
  const name = requireName();
  if (!name) return;
  initAudio();
  const code = el.joinCode.value.trim().toUpperCase();
  if (code.length !== 4) { setRoomStatus('4 harfli oda kodunu gir!'); return; }
  setRoomButtonsEnabled(false);
  setRoomStatus('Odaya bağlanılıyor…');
  try {
    pendingNet = new Net();
    const res = await pendingNet.joinRoom(code, name, PLAYER_ID);
    const net = pendingNet;
    pendingNet = null;
    startGame('guest', net, { myName: name, oppName: (res && res.peerName) || 'RAKİP' });
  } catch (e) {
    const msg = e.message === 'notfound' ? 'Oda bulunamadı!' :
                e.message === 'full' ? 'Oda dolu!' : 'Bağlantı hatası!';
    setRoomStatus(`⚠️ ${msg}`);
    if (pendingNet) { pendingNet.dispose(); pendingNet = null; }
    setRoomButtonsEnabled(true);
  }
});

el.joinCode.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el.btnJoin.click();
});
el.playerName.addEventListener('input', () => el.playerName.classList.remove('invalid'));

el.btnRematch.addEventListener('click', () => { if (game) game.requestRematch(); });
el.btnMenu.addEventListener('click', backToMenu);
el.btnResume.addEventListener('click', () => { if (game) game.setPaused(false); });
el.btnPauseMenu.addEventListener('click', () => { ui.hidePause(); backToMenu(); });

// Ses ilk etkileşimde açılır (tarayıcı politikası)
window.addEventListener('pointerdown', initAudio, { once: false });
window.addEventListener('keydown', initAudio, { once: false });
