import { io } from 'socket.io-client';

// Socket.io sarmalayıcı — oda kur/katıl, hızlı eşleşme + durum/olay iletimi
export class Net {
  constructor() {
    this.socket = io();
    this.onState = null;
    this.onEvent = null;
    this.onPeerJoined = null; // ({ name }) — host'a guest katıldı
    this.onPeerLeft = null;
    this.onDisconnected = null;
    this.onMatched = null;     // ({ code, isHost, peerName }) — hızlı eşleşme oldu

    this.socket.on('state', (d) => this.onState && this.onState(d));
    this.socket.on('event', (d) => this.onEvent && this.onEvent(d));
    this.socket.on('peerJoined', (d) => this.onPeerJoined && this.onPeerJoined(d || {}));
    this.socket.on('peerLeft', () => this.onPeerLeft && this.onPeerLeft());
    this.socket.on('matched', (d) => this.onMatched && this.onMatched(d || {}));
    this.socket.on('disconnect', (reason) => {
      // Kendi isteğimizle kapatmadıysak (sunucu düştü / ağ koptu) haber ver
      if (reason !== 'io client disconnect' && this.onDisconnected) this.onDisconnected();
    });
  }

  // Arkadaşınla oda kur -> { code }
  createRoom(name, id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 8000);
      this.socket.emit('createRoom', { name, id }, (res) => {
        clearTimeout(timer);
        if (res && res.code) resolve(res.code);
        else reject(new Error(res && res.error ? res.error : 'createFailed'));
      });
    });
  }

  // Odaya katıl -> { peerName } (host'un adı)
  joinRoom(code, name, id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 8000);
      this.socket.emit('joinRoom', { code, name, id }, (res) => {
        clearTimeout(timer);
        if (res && res.ok) resolve({ peerName: res.peerName });
        else reject(new Error(res && res.error ? res.error : 'joinFailed'));
      });
    });
  }

  // Hızlı eşleşme -> { queued } (true ise 'matched' olayını bekle)
  quickMatch(name, id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 8000);
      this.socket.emit('quickMatch', { name, id }, (res) => {
        clearTimeout(timer);
        if (res) resolve(res);
        else reject(new Error('quickFailed'));
      });
    });
  }

  cancelQuick() {
    this.socket.emit('cancelQuick');
  }

  sendState(data) {
    this.socket.volatile.emit('state', data);
  }

  sendEvent(data) {
    this.socket.emit('event', data);
  }

  dispose() {
    this.onState = this.onEvent = this.onPeerJoined = this.onPeerLeft = null;
    this.onDisconnected = this.onMatched = null;
    this.socket.disconnect();
  }
}
