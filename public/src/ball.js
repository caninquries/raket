import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { BALL, WORLD_GRAVITY } from './constants.js';
import { GROUP } from './physicsWorld.js';
import { sfx } from './audio.js';

const _fxNormal = new THREE.Vector3();
const _fxZ = new THREE.Vector3(0, 0, 1);
const _trailVel = new THREE.Vector3();

export class Ball {
  constructor(scene, world, mats) {
    this.world = world;
    this.scene = scene;
    this.squash = 0;
    this._lastBounceSfx = 0;
    this.onGround = null; // (side) => void — top yere değince

    this.body = new CANNON.Body({
      mass: BALL.mass,
      shape: new CANNON.Sphere(BALL.radius),
      material: mats.ball,
      linearDamping: BALL.linearDamping,
      angularDamping: 0.25,
      collisionFilterGroup: GROUP.BALL,
      collisionFilterMask: GROUP.WORLD | GROUP.PLAYER | GROUP.RACKET,
      position: new CANNON.Vec3(0, BALL.serveHeight, 0),
    });
    this.body.gameTag = 'ball';
    world.addBody(this.body);

    // Plastik top: gerçek yerçekimini hafifleten sabit yukarı kuvvet
    const m = BALL.mass;
    this._antiGrav = new CANNON.Vec3(0, m * (BALL.effectiveGravity - WORLD_GRAVITY), 0);

    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(BALL.radius, 48, 32),
      new THREE.MeshStandardMaterial({ map: makeBeachTexture(), roughness: 0.55, metalness: 0 })
    );
    this.mesh.castShadow = true;
    scene.add(this.mesh);

    // İniş göstergesi — topun altında beyaz halka
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(BALL.radius * 0.62, BALL.radius * 0.93, 32),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false })
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.015;
    scene.add(this.ring);

    // Sınır çarpma efekti havuzu: duvarda beliren, genişleyip sönen halkalar
    this._fxPool = [];
    this._lastWallFx = 0;
    const fxGeo = new THREE.RingGeometry(BALL.radius * 0.55, BALL.radius * 0.85, 28);
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(
        fxGeo,
        new THREE.MeshBasicMaterial({
          color: 0xffffff, transparent: true, opacity: 0,
          side: THREE.DoubleSide, depthWrite: false,
        })
      );
      m.visible = false;
      m.userData.age = Infinity;
      scene.add(m);
      this._fxPool.push(m);
    }

    // Vuruş izi: top hızlı giderken arkasında süzülen hava halkaları bırakır
    this._trailPool = [];
    this._trailAccum = 0;
    this._hitGlow = 0; // vuruştan hemen sonra iz daha yoğun
    const trailGeo = new THREE.RingGeometry(BALL.radius * 0.5, BALL.radius * 0.72, 20);
    for (let i = 0; i < 40; i++) {
      const m = new THREE.Mesh(
        trailGeo,
        new THREE.MeshBasicMaterial({
          color: 0xeaf6ff, transparent: true, opacity: 0,
          side: THREE.DoubleSide, depthWrite: false,
        })
      );
      m.visible = false;
      m.userData.age = Infinity;
      m.userData.life = 0.4;
      m.userData.s0 = 1;
      scene.add(m);
      this._trailPool.push(m);
    }

    this.body.addEventListener('collide', (e) => {
      const other = e.body;
      const tag = other.gameTag;
      const now = performance.now();
      const impact = Math.abs(this.body.velocity.y) + this.body.velocity.length() * 0.2;

      if (tag === 'ground') {
        this.squash = Math.min(1, impact / 9);
        if (impact > 2 && now - this._lastBounceSfx > 120) {
          sfx.bounce();
          this._lastBounceSfx = now;
        }
        if (this.onGround) this.onGround(this.body.position.x < 0 ? 0 : 1);
      } else if (tag === 'net') {
        if (now - this._lastBounceSfx > 150) { sfx.net(); this._lastBounceSfx = now; }
      } else if (tag === 'wall') {
        if (impact > 2.5 && now - this._lastBounceSfx > 150) { sfx.wall(); this._lastBounceSfx = now; }
        this._spawnWallFx(other.wallInfo, now);
      } else if (tag === 'racket') {
        this.squash = Math.max(this.squash, Math.min(1, impact / 10));
        if (impact > 2 && now - this._lastBounceSfx > 120) { sfx.racket(); this._lastBounceSfx = now; }
        this.hitBurst(other);
      } else if (tag === 'player') {
        this.hitBurst(other); // kafa vuruşunda da efekt
      }
    });
  }

  // Temas noktasında hava patlaması: raketin/kafanın topa değdiği yerde halkalar
  hitBurst(other) {
    this._hitGlow = 0.4;
    const p = this.body.position;
    // Temas noktası ~ topun yüzeyinde, çarpan cisme doğru
    let cx = p.x, cy = p.y, cz = p.z;
    if (other) {
      const dx = other.position.x - p.x, dy = other.position.y - p.y, dz = other.position.z - p.z;
      const d = Math.hypot(dx, dy, dz) || 1;
      cx += (dx / d) * BALL.radius; cy += (dy / d) * BALL.radius; cz += (dz / d) * BALL.radius;
    }
    _trailVel.set(this.body.velocity.x, this.body.velocity.y, this.body.velocity.z);
    if (_trailVel.lengthSq() > 0.001) _trailVel.normalize(); else _trailVel.set(0, 1, 0);
    for (let k = 0; k < 5; k++) {
      const m = this._grabTrail();
      m.position.set(cx, cy, cz);
      m.quaternion.setFromUnitVectors(_fxZ, _trailVel);
      m.userData.age = 0;
      m.userData.life = 0.5;
      m.userData.s0 = 1.3 + k * 0.45;
      m.visible = true;
    }
  }

  _grabTrail() {
    let free = null, oldest = this._trailPool[0], oldAge = -1;
    for (const m of this._trailPool) {
      if (m.userData.age === Infinity) { free = m; break; }
      if (m.userData.age > oldAge) { oldAge = m.userData.age; oldest = m; }
    }
    return free || oldest;
  }

  // Görünmez sınıra çarpınca çarpma noktasında halka efekti
  _spawnWallFx(info, now) {
    if (!info || now - this._lastWallFx < 70) return;
    this._lastWallFx = now;
    const m = this._fxPool.find((f) => f.userData.age === Infinity) || this._fxPool[0];
    const p = this.body.position;
    m.position.set(p.x, p.y, p.z);
    // Çarpma noktasını duvar düzlemine yapıştır
    m.position[info.axis] = info.plane + info.normal[{ x: 0, y: 1, z: 2 }[info.axis]] * 0.04;
    // Halka duvara paralel dursun (normal yönüne baksın)
    _fxNormal.set(info.normal[0], info.normal[1], info.normal[2]);
    m.quaternion.setFromUnitVectors(_fxZ, _fxNormal);
    m.userData.age = 0;
    m.visible = true;
  }

  // Her fizik alt-adımından önce çağrılır (kuvvetler adım sonunda sıfırlanır)
  applyForces() {
    this.body.applyForce(this._antiGrav);
  }

  clampSpeed() {
    const v = this.body.velocity;
    const s = v.length();
    if (s > BALL.maxSpeed) v.scale(BALL.maxSpeed / s, v);
  }

  update(dt) {
    // Vuruş izi: top hızlıyken (>6) yol boyunca halka bırak, sonra hepsini yaşlandır
    this._hitGlow = Math.max(0, this._hitGlow - dt);
    _trailVel.set(this.body.velocity.x, this.body.velocity.y, this.body.velocity.z);
    const trailSpeed = _trailVel.length();
    if (trailSpeed > 6) {
      _trailVel.normalize();
      this._trailAccum += trailSpeed * dt;
      while (this._trailAccum >= 0.5) {
        this._trailAccum -= 0.5;
        const m = this._grabTrail();
        m.position.copy(this.body.position);
        m.quaternion.setFromUnitVectors(_fxZ, _trailVel);
        m.userData.age = 0;
        m.userData.life = 0.4;
        m.userData.s0 = this._hitGlow > 0 ? 1.15 : 0.85;
        m.visible = true;
      }
    } else {
      this._trailAccum = 0;
    }
    for (const m of this._trailPool) {
      if (m.userData.age === Infinity) continue;
      m.userData.age += dt;
      const t = m.userData.age / m.userData.life;
      if (t >= 1) {
        m.visible = false;
        m.userData.age = Infinity;
      } else {
        const s = m.userData.s0 * (0.7 + 1.15 * t);
        m.scale.set(s, s, 1);
        m.material.opacity = 0.5 * (1 - t);
      }
    }

    // Duvar efektlerini ilerlet: 0.45 sn'de genişleyip kaybolur
    for (const m of this._fxPool) {
      if (m.userData.age === Infinity) continue;
      m.userData.age += dt;
      const t = m.userData.age / 0.45;
      if (t >= 1) {
        m.visible = false;
        m.userData.age = Infinity;
      } else {
        const s = 0.6 + 2.4 * t;
        m.scale.set(s, s, 1);
        m.material.opacity = 0.7 * (1 - t);
      }
    }

    this.squash = Math.max(0, this.squash - dt * 5);
    const sq = this.squash * 0.28;
    this.mesh.scale.set(1 + sq * 0.5, 1 - sq, 1 + sq * 0.5);
    this.mesh.position.copy(this.body.position);
    this.mesh.quaternion.copy(this.body.quaternion);

    const h = this.body.position.y;
    this.ring.visible = h > BALL.radius + 0.55;
    if (this.ring.visible) {
      this.ring.position.x = this.body.position.x;
      this.ring.position.z = this.body.position.z;
      const t = Math.min(1, (h - 0.5) / 8);
      this.ring.material.opacity = 0.2 + 0.4 * t;
      const s = 0.7 + 0.5 * t;
      this.ring.scale.set(s, s, 1);
    }
  }

  reset(x, y, z) {
    this.body.position.set(x, y, z);
    this.body.velocity.set(0, 0, 0);
    this.body.angularVelocity.set((Math.random() - 0.5) * 2, 0, (Math.random() - 0.5) * 2);
    this.squash = 0;
  }
}

// Plaj topu dokusu — renkli dikey panolar
function makeBeachTexture() {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 256;
  const g = cv.getContext('2d');
  const colors = ['#ffffff', '#ff6b6b', '#ffffff', '#ffd93d', '#ffffff', '#4dabf7'];
  const w = cv.width / colors.length;
  colors.forEach((c, i) => {
    g.fillStyle = c;
    g.fillRect(Math.floor(i * w), 0, Math.ceil(w) + 1, cv.height);
  });
  // pano dikişleri
  g.strokeStyle = 'rgba(0,0,0,0.08)';
  g.lineWidth = 3;
  for (let i = 0; i <= colors.length; i++) {
    g.beginPath();
    g.moveTo(i * w, 0);
    g.lineTo(i * w, cv.height);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
