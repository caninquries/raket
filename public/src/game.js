import * as THREE from 'three';
import {
  BALL, COURT, PLAYER, PHYS_STEP, RACKET, SIDE_SIGN, TEAM_NAMES, WIN_SCORE, WORLD_GRAVITY,
} from './constants.js';
import { createGraphics, updateClouds } from './graphics.js';
import { createPhysics } from './physicsWorld.js';
import { Character } from './character.js';
import { Ball } from './ball.js';
import { Bot } from './ai.js';
import { Input } from './input.js';
import { sfx } from './audio.js';

// mode: 'single' | 'host' | 'guest'
// Host ve tek oyunculu: fizik + skor otoritesi bizde.
// Guest: kendi karakterini simüle eder, top ve skor host'tan gelir.
export class Game {
  constructor({ mode, net, ui, container, myName = 'SEN', oppName = 'RAKİP' }) {
    this.mode = mode;
    this.net = net || null;
    this.ui = ui;
    this.container = container;

    // Takım: multiplayer'da host=0/guest=1 (protokol); singleplayer'da %50-%50 rastgele
    this.myTeam = mode === 'guest' ? 1 : (mode === 'single' ? (Math.random() < 0.5 ? 0 : 1) : 0);
    this.botTeam = 1 - this.myTeam;
    this.authority = mode !== 'guest';
    this._serveHold = null; // { side, until } — servis dish tutuşu (3.5 sn sınırı)

    this.scores = [0, 0];
    this.roundActive = false;
    this.state = 'playing'; // 'playing' | 'end'
    this.timers = [];
    this.disposed = false;
    this._accum = 0;
    this._lastT = 0;
    this._time = 0; // simülasyon saati (sn) — vuruş bekleme ve ayağa kalkma bununla ölçülür

    // Takım isimleri (saha dışı panolar): benim takımım kendi adım, rakip onun adı
    const teamNames = this.myTeam === 0 ? [myName, oppName] : [oppName, myName];
    const gfx = createGraphics(container, SIDE_SIGN[this.myTeam], teamNames);
    this.gfx = gfx;
    const { world, mats } = createPhysics();
    this.world = world;

    this.chars = [
      new Character({ scene: gfx.scene, world, mats, team: 0, isProxy: mode === 'guest' }),
      new Character({ scene: gfx.scene, world, mats, team: 1, isProxy: mode === 'host' }),
    ];
    this.me = this.chars[this.myTeam];

    this.ball = new Ball(gfx.scene, world, mats);
    this.ball.onGround = (side) => this._onBallGround(side);
    this._setupHitDetection();

    this.input = new Input();
    this.bot = mode === 'single' ? new Bot(this.chars[this.botTeam], this.ball) : null;

    if (this.net) this._setupNet();

    // GTA tarzı serbest yörünge kamerası: fare (pointer lock) yaw/pitch döndürür
    this._orbitYaw = SIDE_SIGN[this.myTeam] * Math.PI / 2; // başlangıçta fileye bakar
    this._orbitPitch = 0.42;
    this._orbitDist = 8.5;
    this._camTarget = new THREE.Vector3(0, 1.0, 0);
    this._camLook = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._throwVec = new THREE.Vector3();
    this._throwOrigin = new THREE.Vector3();
    this._dropVec = new THREE.Vector3();
    this._cradlePos = new THREE.Vector3();
    this.paused = false;
    this._tasks = []; // sim-saatine bağlı zamanlanmış işler (duraklatınca donar)
    this._setupCameraControls();
    this._setupPauseKey();
    this._setupNetBonk();
    this._setupRacketThrowHits();
    this._raf = 0;
    this._sendTimer = null;
  }

  // ---------- Yaşam döngüsü ----------
  start() {
    this.ui.updateScore(this.scores);

    if (this.authority) {
      const serve = Math.random() < 0.5 ? 0 : 1;
      // Guest'in oyunu kurması için küçük bir gecikmeyle ilk raundu başlat
      this._schedule(this.mode === 'host' ? 0.6 : 0.1, () => {
        this._resetRound(serve, true);
      });
    } else {
      this.ui.showMsg('Bağlandı! Maç başlıyor…', 1800);
    }

    if (this.net) {
      this._sendTimer = setInterval(() => this._sendState(), 33);
    }

    this._lastT = performance.now();
    const loop = (t) => {
      if (this.disposed) return;
      this._raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (t - this._lastT) / 1000);
      this._lastT = t;
      this._frame(dt);
    };
    this._raf = requestAnimationFrame(loop);

    // Sekme gizliyken RAF durur; oyun (özellikle multiplayer host) donmasın
    // diye simülasyonu zamanlayıcıyla sürdür. Sekme görünürken hiçbir şey yapmaz.
    this._hiddenTimer = setInterval(() => {
      if (this.disposed || document.visibilityState !== 'hidden') return;
      const t = performance.now();
      const dt = Math.min(0.05, (t - this._lastT) / 1000);
      this._lastT = t;
      this._frame(dt);
    }, 33);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this._raf);
    if (this._sendTimer) clearInterval(this._sendTimer);
    if (this._hiddenTimer) clearInterval(this._hiddenTimer);
    for (const t of this.timers) clearTimeout(t);
    this._tasks = [];
    if (document.pointerLockElement) document.exitPointerLock();
    this.gfx.renderer.domElement.removeEventListener('click', this._onCanvasClick);
    this.gfx.renderer.domElement.removeEventListener('contextmenu', this._onContextMenu);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('keydown', this._onEsc);
    this.input.dispose();
    for (const c of this.chars) c.dispose();
    this.gfx.dispose();
    if (this.net) this.net.dispose();
  }

  _after(ms, fn) {
    this.timers.push(setTimeout(() => {
      if (!this.disposed) fn();
    }, ms));
  }

  // Sim-saatiyle zamanlama: duraklatma sırasında raund akışı da durur
  _schedule(delaySec, fn) {
    this._tasks.push({ at: this._time + delaySec, fn });
  }

  // ---------- Kamera (GTA tarzı) + raket fırlatma ----------
  _setupCameraControls() {
    const canvas = this.gfx.renderer.domElement;
    this._aiming = false; // sağ tuş basılıyken raket fırlatma nişanı
    this._onCanvasClick = () => {
      if (!this.paused && document.pointerLockElement !== canvas) {
        canvas.requestPointerLock();
      }
    };
    this._onMouseMove = (e) => {
      if (document.pointerLockElement !== canvas || this.paused) return;
      this._orbitYaw -= e.movementX * 0.0026;
      this._orbitPitch = clamp(this._orbitPitch + e.movementY * 0.0026, -0.05, 1.15);
    };
    // Sol tuş: manuel vuruş + basılı tutunca dish (topu diskte tut). Sağ tuş: fırlatma nişanı.
    this._holdingLeft = false;
    this._onMouseDown = (e) => {
      if (this.paused) return;
      if (e.button === 0) {
        this._holdingLeft = true;
        // SERVİS tutuşundaysam: sol tık = servis atışı (baktığım yöne).
        // Top henüz diske düşmediyse tık yok sayılır (pencere iptal olmasın).
        if (this._serveHold && this._serveHold.side === this.myTeam) {
          if (this.me._cradling && !this.me.flopped) {
            if (this.authority) {
              this._serveLaunch(this.me);
            } else {
              this._sendEvent({ type: 'serveShoot' });
              this._serveLaunch(this.me); // yerel tahmin — host onaylar
            }
          }
          return;
        }
        this.me.startSwing();
      } else if (e.button === 2 && this.me.racketState === 'held' && !this.me.flopped && !this.me.holdPose) {
        this._aiming = true; // dish modunda (holdPose) fırlatma nişanı açılmaz
      }
    };
    this._onMouseUp = (e) => {
      if (e.button === 0) {
        this._holdingLeft = false;
      } else if (e.button === 2 && this._aiming) {
        this._aiming = false;
        this.gfx.hideThrowPreview();
        this._throwRacket();
      }
    };
    this._onContextMenu = (e) => e.preventDefault(); // sağ tık menüsü çıkmasın
    canvas.addEventListener('click', this._onCanvasClick);
    canvas.addEventListener('contextmenu', this._onContextMenu);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
  }

  // Kameranın baktığı yöne (yatay + dikey nişan) göre normalize fırlatma yönü.
  // Düz/yukarı bakınca kavisli uzağa, aşağı bakınca düz/alçak (rakibe) gider.
  _throwDir(out) {
    const fwdX = -Math.sin(this._orbitYaw);
    const fwdZ = -Math.cos(this._orbitYaw);
    const elev = clamp(RACKET.throwUp + 0.1 - this._orbitPitch * 0.8, -0.35, 0.75);
    const ce = Math.cos(elev), se = Math.sin(elev);
    out.set(fwdX * ce, se, fwdZ * ce).normalize();
    return out;
  }

  _throwRacket() {
    if (this.me.racketState !== 'held' || this.me.flopped) return;
    const dir = this._throwDir(this._throwVec);
    this.me.throwRacket(dir);
    this._sendEvent({ type: 'throw', dir: [round3(dir.x), round3(dir.y), round3(dir.z)] });
  }

  // ---------- Duraklatma (yalnızca tek oyunculu) ----------
  _setupPauseKey() {
    this._onEsc = (e) => {
      if (e.code === 'Escape' && this.mode === 'single' && this.state !== 'end') {
        this.setPaused(!this.paused);
      }
    };
    window.addEventListener('keydown', this._onEsc);
  }

  setPaused(v) {
    if (this.mode !== 'single' || this.paused === v) return;
    this.paused = v;
    if (v) {
      if (document.pointerLockElement) document.exitPointerLock();
      this.ui.showPause();
    } else {
      this.ui.hidePause();
    }
  }

  // ---------- Fileye dokunan zıplayan karakter devrilir ----------
  _setupNetBonk() {
    const netBody = this.world.bodies.find((b) => b.gameTag === 'net');
    if (!netBody) return;
    netBody.addEventListener('collide', (e) => {
      // Yalnızca oyuncu GÖVDESİ fileye çarpınca devrilir; fırlatılan raket devirmez
      if (!e.body || e.body.gameTag !== 'player') return;
      const char = e.body.charRef;
      if (!char || char.flopped) return;
      char.stagger(this._time);
      const b = char.body;
      b.velocity.set(char.side * 4.2, 3, b.velocity.z * 0.3);
      b.angularVelocity.set(
        (Math.random() - 0.5) * 3,
        (Math.random() - 0.5) * 2,
        -char.side * (6 + Math.random() * 3)
      );
      sfx.boing();
    });
  }

  // ---------- Dish (sol tık tut): topu diskin ortasında taşı, fareyle sektir ----------
  _updateBallCradle(dt) {
    const bb = this.ball.body;
    for (const c of this.chars) {
      // Guest yalnızca KENDİ karakteri için tahmin yürütür (top host'tan düzeltilir)
      if (!this.authority && c !== this.me) continue;
      const wasCradling = c._cradling;
      c._cradling = false;
      const isServe = this._serveHold && this._serveHold.side === c.team;
      if (!c.holdPose) {
        // Sol tık bırakıldı: topu diskte tutuyorduysak baktığı yöne + yukarı FIRLAT
        // (servis tutuşu flop/zıplamayla bozulduysa fırlatma — top düşsün)
        if (wasCradling && !isServe) this._launchFromDish(c);
        c._cradleT = 0;
        continue;
      }
      // Atıştan hemen sonra topu tekrar yakalama (kaçabilsin)
      if (this._time < (c._cradleReleaseUntil || 0)) { c._cradleT = 0; continue; }
      // Guest: host topu fırlattıysa (hız yüksek) beşiğe geri çekme
      if (!this.authority && !wasCradling && bb.velocity.length() > 10) { c._cradleT = 0; continue; }
      c.racketHead.getWorldPosition(this._cradlePos);
      // Disk yukarı bakıyor: dinlenme noktası diskin biraz üstünde
      const rx = this._cradlePos.x, ry = this._cradlePos.y + BALL.radius + 0.05, rz = this._cradlePos.z;
      const dx = rx - bb.position.x, dy = ry - bb.position.y, dz = rz - bb.position.z;
      if (Math.hypot(dx, dy, dz) > BALL.radius * 2.2) { c._cradleT = 0; continue; } // top diskte değil
      c._cradleT = (c._cradleT || 0) + dt;
      if (isServe) {
        // SERVİS: 3.5 sn sınırı (top yakalanınca başlar); bot ~1.2 sn'de servis atar
        if (this._serveHold.until === null) this._serveHold.until = this._time + RACKET.serveHoldTime;
        const botServing = this.bot && c.team === this.botTeam;
        if (this.authority && (this._time >= this._serveHold.until || (botServing && c._cradleT >= 1.2))) {
          this._serveLaunch(c);
          continue;
        }
      } else if (c._cradleT >= 2) {
        // Normal dish: 2 saniye sınırı
        this._launchFromDish(c);
        c._cradleT = 0;
        c._cradleReleaseUntil = this._time + 0.6;
        continue;
      }
      // Beşik: topu diskin ortasına çek ve orada tut (sekmeden, hızı sıfırla).
      // Disk (karakter) hareket edince rest noktası da hareket eder, top takip eder.
      const k = Math.min(1, 16 * dt);
      bb.position.x += dx * k; bb.position.y += dy * k; bb.position.z += dz * k;
      bb.velocity.set(0, 0, 0);
      bb.angularVelocity.set(0, 0, 0);
      c._cradling = true;
      break; // aynı anda tek disk taşır
    }
  }

  // Servis atışı: fırlat + servis tutuşunu kapat (guest'e bildir)
  _serveLaunch(c) {
    this._launchFromDish(c);
    this._serveHold = null;
    c._cradleT = 0;
    c._cradleReleaseUntil = this._time + 0.6;
    if (this.authority) this._sendEvent({ type: 'serveDone' });
  }

  // Dish'ten bırakınca: topu karakterin baktığı yöne kavisle fırlat (servis/pas)
  _launchFromDish(c) {
    const bb = this.ball.body;
    // Top hâlâ diskin yakınındaysa fırlat (uzağa gittiyse dokunma)
    c.racketHead.getWorldPosition(this._cradlePos);
    if (this._cradlePos.distanceTo(bb.position) > BALL.radius * 3) return;
    const fy = c.faceYaw != null ? c.faceYaw : Math.atan2(-c.side, 0);
    let dx = Math.sin(fy), dz = Math.cos(fy);
    const forward = -c.side;
    if (dx * forward < 0.05) dx = forward * 0.05; // kendi sahana gitmesin
    const dy = RACKET.hitArc;
    const len = Math.hypot(dx, dy, dz) || 1;
    const s = RACKET.hitSpeed * 0.9;
    bb.velocity.set((dx / len) * s, (dy / len) * s, (dz / len) * s);
  }

  // ---------- Fırlatılan raket bir oyuncuya çarparsa ----------
  _setupRacketThrowHits() {
    for (const attacker of this.chars) {
      attacker.racketBody.addEventListener('collide', (e) => {
        if (attacker.racketState !== 'flying') return;
        const other = e.body;
        if (other && other.gameTag === 'player' && other.charRef && other.charRef !== attacker) {
          this._racketHitsPlayer(other.charRef, attacker);
        }
      });
    }
  }

  // Kurbanı savur + 1 sn bayılt, elindeki raketi düşür (kendisi bir yön, raket başka yön)
  _racketHitsPlayer(victim, attacker) {
    if (victim.flopped) return;
    if (this._time - victim._lastRacketBonk < 0.5) return; // çift-tetik koruması
    victim._lastRacketBonk = this._time;

    // 1) Kurban raketini düşürsün (henüz yığılmadan — yana/yukarı savrulur)
    if (victim.racketState === 'held') {
      this._dropVec.set((Math.random() - 0.5) * 0.5, 0.85, Math.random() < 0.5 ? 1 : -1).normalize();
      victim.throwRacket(this._dropVec);
    }

    // 2) Kurbanın kendisi gelen raketten UZAĞA savrulsun + 1 sn bayılsın
    victim.stagger(this._time);
    victim.staggerUntil = this._time + 1.0;
    const away = Math.sign(victim.body.position.x - attacker.racketBody.position.x) || -victim.side;
    victim.body.velocity.set(away * 6, 4.5, (Math.random() - 0.5) * 4);
    victim.body.angularVelocity.set(
      (Math.random() - 0.5) * 6,
      (Math.random() - 0.5) * 4,
      (Math.random() - 0.5) * 9
    );
    sfx.boing();
    this._sendEvent({ type: 'racketBonk', team: victim.team });
  }

  // ---------- Her kare ----------
  _frame(dt) {
    // Duraklatıldıysa sadece görüntüyü çiz, simülasyonu dondur
    if (this.paused) {
      this.gfx.renderer.render(this.gfx.scene, this.gfx.camera);
      return;
    }

    this._time += dt;

    // Zamanı gelen işleri çalıştır (raund geçişleri vb.)
    if (this._tasks.length) {
      const due = this._tasks.filter((t) => t.at <= this._time);
      if (due.length) {
        this._tasks = this._tasks.filter((t) => t.at > this._time);
        for (const t of due) t.fn();
      }
    }

    // 1) Girdiler — kamera yönüne göre strafe hareket; oyuncu HEP fareye bakar
    const rawIn = this.input.raw();
    const fwdX = -Math.sin(this._orbitYaw);
    const fwdZ = -Math.cos(this._orbitYaw);
    let mx = fwdX * rawIn.f - fwdZ * rawIn.r;   // right = (-fwdZ, fwdX)
    let mz = fwdZ * rawIn.f + fwdX * rawIn.r;
    const mLen = Math.hypot(mx, mz);
    if (mLen > 1) { mx /= mLen; mz /= mLen; }
    if (rawIn.sprint) { mx *= 1.5; mz *= 1.5; } // sol shift: %50 hızlanma
    this.me.faceYaw = Math.atan2(fwdX, fwdZ); // karakter fare-bakış yönüne döner
    this.me.wantHold = this._holdingLeft;     // sol tık basılı: dish modu
    this.me.holdPitch = this._orbitPitch;     // dish yüksekliği farenin dikey açısı
    // Servis tutuşu sırasında servisçi zıplayamaz (dish pozu bozulmasın)
    const iAmServing = this._serveHold && this._serveHold.side === this.myTeam;
    this.me.applyControl({ x: mx, z: mz }, rawIn.jump && !iAmServing, dt, sfx);

    if (this.bot) {
      const b = this.bot.update(dt);
      const botServing = this._serveHold && this._serveHold.side === this.botTeam;
      const botChar = this.chars[this.botTeam];
      botChar.applyControl(botServing ? { x: 0, z: 0 } : b.move, b.jump && !botServing, dt, null);
      if (b.swing && !botServing) botChar.startSwing();
    }

    // SERVİS her zaman dish modunda: servisçinin diski raund başından itibaren düz
    if (this._serveHold) {
      const sc = this.chars[this._serveHold.side];
      if (!sc.flopped && !sc.jumpTumble) {
        sc.wantHold = true;
        sc.holdPose = true;
      }
    }

    for (const c of this.chars) c.applyNetTarget(dt);

    // 2) Fizik — sabit alt adımlar, top kuvveti her alt adımda
    this._accum += dt;
    let steps = 0;
    while (this._accum >= PHYS_STEP && steps < 10) {
      this.ball.applyForces();
      this.world.step(PHYS_STEP);
      this._accum -= PHYS_STEP;
      steps++;
    }
    if (steps === 10) this._accum = 0; // sekme birikmesini önle

    // 3) Sınırlar + geri tepmeden ayağa kalkma
    for (const c of this.chars) {
      if (c.flopped && c.staggerUntil > 0 && this._time >= c.staggerUntil) c.recoverInPlace();
      c.clampToSide();
    }
    this.ball.clampSpeed();

    // 4) Görseller (raket fizik gövdeleri de burada görsele eşitlenir)
    const bp = this.ball.body.position;
    for (const c of this.chars) c.update(dt, bp, this._time);
    // Dish beşiği: authority tüm karakterler için, guest KENDİ karakteri için
    // yerel tahmin yapar (lag'da dish'in kopmasını önler — mavi takım optimizasyonu)
    this._updateBallCradle(dt);
    this.ball.update(dt);
    updateClouds(this.gfx.clouds, dt);
    this.gfx.updateSun(dt); // güneş yavaşça döner, gölgeler değişir

    // Serbest yörünge kamerası (GTA tarzı) + spring-arm: kamera oyuncudan istenen
    // yöne uzanır ama tel kafese denk gelirse mesafesini kısaltıp ASLA sınırı geçmez.
    const mp = this.me.body.position;
    const cosP = Math.cos(this._orbitPitch);
    const dx = Math.sin(this._orbitYaw) * cosP;
    const dy = Math.sin(this._orbitPitch);
    const dz = Math.cos(this._orbitYaw) * cosP;
    // Kafes içi kutu (telden biraz içeride) — kamera bu kutunun dışına çıkamaz
    const bx = COURT.wallX - 0.3, bz = COURT.wallZ - 0.3, byTop = COURT.ceilY - 0.3;
    let maxD = this._orbitDist;
    if (dx > 1e-3) maxD = Math.min(maxD, (bx - mp.x) / dx);
    else if (dx < -1e-3) maxD = Math.min(maxD, (-bx - mp.x) / dx);
    if (dz > 1e-3) maxD = Math.min(maxD, (bz - mp.z) / dz);
    else if (dz < -1e-3) maxD = Math.min(maxD, (-bz - mp.z) / dz);
    if (dy > 1e-3) maxD = Math.min(maxD, (byTop - mp.y) / dy);
    maxD = Math.max(0.4, maxD); // duvara sıkışsa bile çok az bir mesafe kalsın
    this._camPos.set(
      mp.x + dx * maxD,
      Math.max(0.7, mp.y + dy * maxD),
      mp.z + dz * maxD
    );
    this.gfx.camera.position.lerp(this._camPos, Math.min(1, 14 * dt));
    this._camLook.set(mp.x, mp.y + 1.35, mp.z);
    this._camTarget.lerp(this._camLook, Math.min(1, 18 * dt));
    this.gfx.camera.lookAt(this._camTarget);

    // Kamera oyuncuya yaklaşınca (duvara sıkışınca) KENDİ karakterini/raketini soldur ki
    // görüşü kapatmasın. Yalnızca yerel görünüm — rakip seni normal görür.
    // Tam mesafe (8.5) = tam görünür; kamera kısalmaya başlayınca kademeli solar.
    const cpos = this.gfx.camera.position;
    const camDist = Math.hypot(cpos.x - mp.x, cpos.y - (mp.y + 0.6), cpos.z - mp.z);
    // En fazla %90 saydamlaşır (opaklık tabanı 0.1 — oyuncu tamamen kaybolmasın)
    this.me.setOpacity(clamp((camDist - 2.0) / (7.0 - 2.0), 0.1, 1));

    // Raket fırlatma nişanı: yörünge önizlemesi
    if (this._aiming && this.me.racketState === 'held' && !this.me.flopped && !this.me.holdPose) {
      this._updateThrowPreview();
    } else if (this._aiming) {
      // Artık fırlatılamaz (yığıldı / dish moduna girdi): önizlemeyi kapat
      this._aiming = false;
      this.gfx.hideThrowPreview();
    }

    this.gfx.renderer.render(this.gfx.scene, this.gfx.camera);
  }

  // Fırlatılacak raketin izleyeceği yayı hesapla ve göster
  _updateThrowPreview() {
    this.me.racketHead.getWorldPosition(this._throwOrigin);
    const dir = this._throwDir(this._throwVec);
    let px = this._throwOrigin.x, py = this._throwOrigin.y, pz = this._throwOrigin.z;
    let vx = dir.x * RACKET.throwSpeed, vy = dir.y * RACKET.throwSpeed, vz = dir.z * RACKET.throwSpeed;
    const h = 1 / 30;
    const pts = [];
    for (let i = 0; i < 45; i++) {
      pts.push(px, py, pz);
      vy += WORLD_GRAVITY * h;
      px += vx * h; py += vy * h; pz += vz * h;
      if (py < 0.15) { pts.push(px, 0.15, pz); break; }
    }
    this.gfx.showThrowPreview(pts);
  }

  // ---------- Kafa vuruşu ----------
  _setupHitDetection() {
    this.ball.body.addEventListener('collide', (e) => {
      const other = e.body;
      if (other.gameTag !== 'player') return;
      const char = other.charRef;
      if (!char || char.flopped) return;

      // Elinde raket varsa beden pasif: top ne savurur ne bayıltır (raketle kontrol için)
      if (char.racketState === 'held') return;

      const now = this._time;
      if (now - char.lastHit < PLAYER.hitCooldown) return;
      char.lastHit = now;

      this._applyHit(char);
      this._knockback(char);
      sfx.hit();
      sfx.boing();
      this.ball.squash = Math.max(this.ball.squash, 0.5);
    });
  }

  // Vuruşun geri tepmesi: oyuncu komik şekilde geriye savrulup düşer, kısa sürede kalkar
  _knockback(char) {
    const s = char.side;
    char.stagger(this._time);
    const b = char.body;
    b.velocity.set(s * 3.8, 3.4, (Math.random() - 0.5) * 2);
    b.angularVelocity.set(
      (Math.random() - 0.5) * 3,
      (Math.random() - 0.5) * 3,
      -s * (6 + Math.random() * 3) // fileden uzağa doğru takla
    );
  }

  _applyHit(char) {
    const bp = this.ball.body.position;
    const cp = char.body.position;
    const cv = char.body.velocity;
    const s = char.side;
    const v = this.ball.body.velocity;

    const inAir = char.inAir();

    if (inAir && bp.y > COURT.netHeight + 0.2) {
      // SMAÇ! Havadayken yüksek topa vurunca rakip sahaya doğru çakılır
      const aimX = -s * (COURT.halfLenX * 0.45) + char.moveInput.x * 4;
      const aimZ = clamp(bp.z * 0.4 + char.moveInput.z * 5, -COURT.halfWidZ + 0.5, COURT.halfWidZ - 0.5);
      const dx = aimX - bp.x;
      const dz = aimZ - bp.z;
      const dy = 0.3 - bp.y;
      const len = Math.max(0.001, Math.hypot(dx, dy, dz));
      const power = PLAYER.hitPower + PLAYER.smashBonus;
      v.set((dx / len) * power, (dy / len) * power * 0.85 + 1.5, (dz / len) * power);
    } else {
      // Normal kafa vuruşu: temas yönü + oyuncu hızı + basılı yön
      const hx = bp.x - cp.x;
      const hy = bp.y - (cp.y + 0.55);
      const hz = bp.z - cp.z;
      const len = Math.max(0.001, Math.hypot(hx, hy, hz));
      v.set(
        (hx / len) * PLAYER.hitPower + -s * PLAYER.towardNet + char.moveInput.x * PLAYER.steerPower + cv.x * 0.35,
        (hy / len) * PLAYER.hitPower,
        (hz / len) * PLAYER.hitPower + char.moveInput.z * PLAYER.steerPower + cv.z * 0.35
      );
      if (v.y < PLAYER.upMin) v.y = PLAYER.upMin;
    }

    // Topa görsel spin ver
    this.ball.body.angularVelocity.set(-v.z * 1.2, 0, v.x * 1.2);
    this.ball.clampSpeed();
  }

  // ---------- Skor & raund akışı ----------
  _onBallGround(landSide) {
    if (!this.authority || !this.roundActive || this.state === 'end') return;
    this.roundActive = false;
    const scorer = 1 - landSide;
    this.scores[scorer]++;

    this._announcePoint(scorer, landSide);
    this._sendEvent({ type: 'point', scores: [...this.scores], landSide });

    if (this.scores[scorer] >= WIN_SCORE) {
      this._schedule(1.6, () => this._matchEnd(scorer));
    } else {
      // 3 saniye sonra yeni raund — sayıyı kazanan servis kullanır
      this._schedule(3, () => {
        this._resetRound(scorer, false);
        this._sendEvent({ type: 'reset', serve: scorer, scores: [...this.scores] });
      });
    }
  }

  _announcePoint(scorer, landSide) {
    this.ui.updateScore(this.scores);
    sfx.whistle();
    if (scorer === this.myTeam) sfx.score();
    else sfx.concede();
    // Sayıyı yiyen takım raketini düşürür ve komik şekilde yığılır (raund resetine kadar)
    this.chars[landSide].dropRacket();
    this.chars[landSide].flop();
    this.chars[landSide].staggerUntil = 0;
  }

  _resetRound(serveSide, isFirst) {
    if (this.state === 'end') return;
    // Oyuncular ARKA ÇİZGİDE dizilir
    for (const c of this.chars) c.resetPose(c.side * PLAYER.spawnX, 0);
    // SERVİS: top yukarıdan düşmez — doğrudan servisçinin diskinde hazır durur.
    // Servisçi dish modundadır; yön verip sol tıkla başlar (3.5 sn'de otomatik).
    const sc = this.chars[serveSide];
    sc._cradleT = 0;
    sc._cradleReleaseUntil = 0;
    const spot = sc.prepareServeDish(this._cradlePos);
    this.ball.reset(spot.x, spot.y, spot.z);
    this._serveHold = { side: serveSide, until: null };
    // Her serviste kamera sıfırlanır (arkaya dönük unutulmasın)
    this._orbitYaw = SIDE_SIGN[this.myTeam] * Math.PI / 2;
    this._orbitPitch = 0.42;
    this.roundActive = true;
    this.ui.updateScore(this.scores);
    if (isFirst) this.ui.showMsg('Maç başlıyor! 🏓', 1500);
  }

  _matchEnd(winner) {
    this.state = 'end';
    this.roundActive = false;
    this._serveHold = null;
    this._sendEvent({ type: 'matchEnd', winner, scores: [...this.scores] });
    this._showEnd(winner);
  }

  _showEnd(winner) {
    this.state = 'end';
    if (winner === this.myTeam) sfx.win();
    else sfx.lose();
    const emoji = winner === this.myTeam ? '🏆 Kazandın!' : '😵 Kaybettin!';
    this.ui.showEnd(`${TEAM_NAMES[winner]} TAKIM KAZANDI\n${emoji}`, this.scores);
  }

  // "Yeni Maç" — host/single başlatır, guest istek yollar
  requestRematch() {
    if (this.authority) {
      this._doRematch();
      this._sendEvent({ type: 'rematchStart' });
    } else {
      this._sendEvent({ type: 'rematchRequest' });
      this.ui.showMsg('Yeni maç istendi…', 2000);
    }
  }

  _doRematch() {
    this.scores = [0, 0];
    this.state = 'playing';
    this.ui.hideEnd();
    this.ui.updateScore(this.scores);
    const serve = Math.random() < 0.5 ? 0 : 1;
    this._resetRound(serve, true);
    if (this.authority) {
      this._sendEvent({ type: 'reset', serve, scores: [0, 0] });
    }
  }

  // ---------- Ağ ----------
  _setupNet() {
    this.net.onState = (d) => this._onNetState(d);
    this.net.onEvent = (d) => this._onNetEvent(d);
    this.net.onPeerLeft = () => {
      this.ui.showMsg('Rakip oyundan ayrıldı 😢', 2500);
      this._after(2500, () => this.onExit && this.onExit());
    };
    this.net.onDisconnected = () => {
      this.ui.showMsg('Bağlantı koptu! 😢', 2500);
      this._after(2500, () => this.onExit && this.onExit());
    };
  }

  _sendEvent(data) {
    if (this.net) this.net.sendEvent(data);
  }

  _sendState() {
    if (!this.net || this.disposed) return;
    const b = this.me.body;
    const packet = {
      p: [round3(b.position.x), round3(b.position.y), round3(b.position.z)],
      v: [round3(b.velocity.x), round3(b.velocity.y), round3(b.velocity.z)],
      m: [round3(this.me.moveInput.x), round3(this.me.moveInput.z)],
      f: this.me.flopped ? 1 : 0, // rakip ekranda da yığılmış görünsün
      sw: this.me.swingT >= 0 ? 1 : 0, // raket salınımı da görünsün (fizik raketi de oynatır)
      fy: round3(this.me.faceYaw || 0), // fare-bakış yönü
      hp: this.me.holdPose ? 1 : 0, // dish pozu
      hpi: round3(this.me.holdPitch), // dish yüksekliği
    };
    if (this.authority) {
      const bb = this.ball.body;
      packet.ball = {
        p: [round3(bb.position.x), round3(bb.position.y), round3(bb.position.z)],
        v: [round3(bb.velocity.x), round3(bb.velocity.y), round3(bb.velocity.z)],
      };
      packet.scores = this.scores;
    }
    this.net.sendState(packet);
  }

  _onNetState(d) {
    // Bozuk/NaN içeren paketler fizik motorunu zehirlemesin
    if (this.disposed || !d || !finiteArr(d.p, 3)) return;
    const remote = this.chars[1 - this.myTeam];
    remote.netTarget = {
      p: d.p,
      v: finiteArr(d.v, 3) ? d.v : [0, 0, 0],
      m: finiteArr(d.m, 2) ? d.m : [0, 0],
    };
    // Yığılma durumunu eşitle (file çarpması / geri tepme uzaktan da görünsün)
    if (d.f && !remote.flopped) {
      remote.flop();
    } else if (!d.f && remote.flopped && this.roundActive) {
      remote.recoverInPlace();
    }
    // Raket salınımını eşitle (fizik raketi görselle birlikte hareket eder)
    if (d.sw && remote.swingT < 0 && !remote.flopped) remote.startSwing();
    // Rakip de kendi fare-bakış yönüne dönsün
    if (Number.isFinite(d.fy)) remote.faceYaw = d.fy;
    // Dish pozu senkronu (görsel): rakip diski düz tutuyorsa göster
    if (Number.isFinite(d.hpi)) remote.holdPitch = d.hpi;
    remote.wantHold = !!d.hp;
    if (d.hp) remote.holdPose = true;
    else if (remote.holdPose) remote.holdPose = false;

    // Guest: top host'tan gelir
    if (!this.authority && d.ball && finiteArr(d.ball.p, 3) && finiteArr(d.ball.v, 3)) {
      const bb = this.ball.body;
      const [sx, sy, sz] = d.ball.p;
      const dx = sx - bb.position.x, dy = sy - bb.position.y, dz = sz - bb.position.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > 1.5) {
        bb.position.set(sx, sy, sz);
      } else {
        bb.position.x += dx * 0.35;
        bb.position.y += dy * 0.35;
        bb.position.z += dz * 0.35;
      }
      bb.velocity.set(d.ball.v[0], d.ball.v[1], d.ball.v[2]);
      if (validScores(d.scores) && (d.scores[0] !== this.scores[0] || d.scores[1] !== this.scores[1])) {
        this.scores = [...d.scores];
        this.ui.updateScore(this.scores);
      }
    }
  }

  _onNetEvent(d) {
    if (this.disposed || !d) return;
    // Olay paketlerini doğrula
    if (['point', 'reset', 'matchEnd'].includes(d.type) && !validScores(d.scores)) return;
    if (d.type === 'point' && d.landSide !== 0 && d.landSide !== 1) return;
    if (d.type === 'reset' && d.serve !== 0 && d.serve !== 1) return;
    if (d.type === 'matchEnd' && d.winner !== 0 && d.winner !== 1) return;
    switch (d.type) {
      case 'point':
        if (!this.authority) {
          this.scores = [...d.scores];
          this.roundActive = false;
          this._announcePoint(1 - d.landSide, d.landSide);
        }
        break;
      case 'reset':
        if (!this.authority) {
          this.scores = [...d.scores];
          this.state = 'playing';
          this.ui.hideEnd();
          this._resetRound(d.serve, d.scores[0] === 0 && d.scores[1] === 0);
        }
        break;
      case 'matchEnd':
        if (!this.authority) {
          this.scores = [...d.scores];
          this._serveHold = null; // maç sonu ekranında dish zorlaması kalmasın
          this.ui.updateScore(this.scores);
          this._showEnd(d.winner);
        }
        break;
      case 'rematchRequest':
        if (this.authority && this.state === 'end') {
          this._doRematch();
          this._sendEvent({ type: 'rematchStart' });
        }
        break;
      case 'rematchStart':
        if (!this.authority) {
          this.scores = [0, 0];
          this.state = 'playing';
          this.ui.hideEnd();
          this.ui.updateScore(this.scores);
        }
        break;
      case 'throw': {
        // Rakip raketini fırlattı: onun proxy karakterinde aynı fırlatmayı oynat
        const remote = this.chars[1 - this.myTeam];
        if (finiteArr(d.dir, 3) && remote) {
          remote.throwRacket(this._throwVec.set(d.dir[0], d.dir[1], d.dir[2]));
        }
        break;
      }
      case 'serveShoot': {
        // Guest servis attı: host onun karakteri için servisi başlat
        if (this.authority && this._serveHold && this._serveHold.side !== this.myTeam) {
          this._serveLaunch(this.chars[this._serveHold.side]);
        }
        break;
      }
      case 'serveDone': {
        if (!this.authority) {
          this._serveHold = null;
          // Host servisi başlattı: yerel beşik topu sabitlemeye devam etmesin
          // (kısa süre yakalama kapalı — top serbestçe uçsun, snapshot'lar yönetsin)
          this.me._cradleT = 0;
          this.me._cradleReleaseUntil = this._time + 0.6;
        }
        break;
      }
      case 'racketBonk': {
        // Rakibin fırlattığı raket beni vurdu: raketimi düşür + yığıl
        if (d.team === this.myTeam && !this.me.flopped) {
          if (this.me.racketState === 'held') {
            this._dropVec.set((Math.random() - 0.5) * 0.5, 0.85, Math.random() < 0.5 ? 1 : -1).normalize();
            this.me.throwRacket(this._dropVec);
          }
          this.me.stagger(this._time);
          this.me.staggerUntil = this._time + 1.0;
          this.me.body.velocity.set(this.me.side * -6, 4.5, (Math.random() - 0.5) * 4);
          sfx.boing();
        }
        break;
      }
    }
  }
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function finiteArr(a, n) {
  if (!Array.isArray(a) || a.length < n) return false;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(a[i])) return false;
  }
  return true;
}

function validScores(s) {
  return Array.isArray(s) && s.length === 2 &&
    Number.isInteger(s[0]) && Number.isInteger(s[1]) &&
    s[0] >= 0 && s[0] <= 99 && s[1] >= 0 && s[1] <= 99;
}
