import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules/three')));
app.use('/vendor/cannon-es', express.static(path.join(__dirname, 'node_modules/cannon-es')));

const server = http.createServer(app);
const io = new Server(server);

// Oda yönetimi: kod -> { host, guest, hostName, guestName }
const rooms = new Map();
// Hızlı eşleşme kuyruğu: eşleşmek isteyen bekleyen soketler
const quickQueue = [];
const CODE_CHARS = 'ABCDEFGHJKLMNPRSTUVYZ23456789';

function makeCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
  } while (rooms.has(code));
  return code;
}

function cleanName(n) {
  return String(n || '').trim().slice(0, 12) || 'Oyuncu';
}

// Soketi kuyruktan çıkar
function leaveQueue(socket) {
  const i = quickQueue.indexOf(socket);
  if (i >= 0) quickQueue.splice(i, 1);
}

// Soketi mevcut odasından çıkarır; oda üyesiyse odayı kapatır ve karşı tarafa haber verir
function leaveCurrentRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  socket.data.roomCode = null;
  socket.leave(code);
  const room = rooms.get(code);
  if (room && (room.host === socket.id || room.guest === socket.id)) {
    socket.to(code).emit('peerLeft');
    rooms.delete(code);
    io.in(code).socketsLeave(code); // kod tekrar kullanılırsa eski üye yabancı paket almasın
  }
}

// İki soketi bir odada eşleştir (a = host, b = guest) ve isimleri karşılıklı bildir
function pairSockets(a, b) {
  const code = makeCode();
  rooms.set(code, { host: a.id, guest: b.id, hostName: a.data.name, guestName: b.data.name });
  a.join(code); b.join(code);
  a.data.roomCode = code; b.data.roomCode = code;
  // host = team 0, guest = team 1
  io.to(a.id).emit('matched', { code, isHost: true, peerName: b.data.name });
  io.to(b.id).emit('matched', { code, isHost: false, peerName: a.data.name });
}

io.on('connection', (socket) => {
  socket.data.name = 'Oyuncu';

  // --- Arkadaşınla oda kur ---
  socket.on('createRoom', (payload, cb) => {
    if (typeof cb !== 'function') return;
    leaveQueue(socket);
    leaveCurrentRoom(socket);
    if (rooms.size >= 500) return cb({ error: 'serverfull' });
    socket.data.name = cleanName(payload && payload.name);
    socket.data.pid = payload && payload.id;
    const code = makeCode();
    rooms.set(code, { host: socket.id, guest: null, hostName: socket.data.name, guestName: null });
    socket.join(code);
    socket.data.roomCode = code;
    cb({ code });
  });

  socket.on('joinRoom', (payload, cb) => {
    if (typeof cb !== 'function') return;
    leaveQueue(socket);
    leaveCurrentRoom(socket);
    const code = String(payload && payload.code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb({ error: 'notfound' });
    if (room.guest) return cb({ error: 'full' });
    socket.data.name = cleanName(payload && payload.name);
    socket.data.pid = payload && payload.id;
    room.guest = socket.id;
    room.guestName = socket.data.name;
    socket.join(code);
    socket.data.roomCode = code;
    cb({ ok: true, peerName: room.hostName }); // guest host'un adını alır
    io.to(room.host).emit('peerJoined', { name: socket.data.name }); // host guest'in adını alır
  });

  // --- Hızlı eşleşme (rastgele rakip) ---
  socket.on('quickMatch', (payload, cb) => {
    if (typeof cb !== 'function') return;
    leaveQueue(socket);
    leaveCurrentRoom(socket);
    socket.data.name = cleanName(payload && payload.name);
    socket.data.pid = payload && payload.id;
    // Kuyrukta bekleyen (bağlı) biri var mı?
    let peer = null;
    while (quickQueue.length) {
      const cand = quickQueue.shift();
      if (cand && cand.connected && cand.id !== socket.id) { peer = cand; break; }
    }
    if (peer) {
      cb({ queued: false });
      pairSockets(peer, socket); // ilk gelen host olur
    } else {
      quickQueue.push(socket);
      cb({ queued: true });
    }
  });

  socket.on('cancelQuick', () => leaveQueue(socket));

  // Oyun durumu paketleri: odadaki diğer oyuncuya aynen iletilir
  socket.on('state', (data) => {
    const code = socket.data.roomCode;
    if (code) socket.to(code).volatile.emit('state', data);
  });

  // Güvenilir oyun olayları (sayı, raund sıfırlama vb.)
  socket.on('event', (data) => {
    const code = socket.data.roomCode;
    if (code) socket.to(code).emit('event', data);
  });

  socket.on('disconnect', () => {
    leaveQueue(socket);
    leaveCurrentRoom(socket);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Kafa Voleybolu hazir: http://localhost:${PORT}`);
});
