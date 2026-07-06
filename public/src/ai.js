import { BALL, COURT, PLAYER, PHYS_STEP } from './constants.js';

// Tek oyunculu bot: topun düşeceği yeri tahmin eder, altına koşar, zamanında zıplar
export class Bot {
  constructor(character, ball) {
    this.char = character;
    this.ball = ball;
    this.side = character.side;
    this.home = this.side * (COURT.halfLenX * 0.5);
    this.target = { x: this.home, z: 0 };
    this.replanTimer = 0;
    this.noise = { x: 0, z: 0 };
    this.jumpJitter = 0;
  }

  update(dt) {
    this.replanTimer -= dt;
    if (this.replanTimer <= 0) {
      this.replanTimer = 0.13;
      this._plan();
    }

    const p = this.char.body.position;
    const bp = this.ball.body.position;
    let dx = this.target.x - p.x;
    let dz = this.target.z - p.z;
    const dist = Math.hypot(dx, dz);

    let move = { x: 0, z: 0 };
    if (dist > 0.18) {
      move.x = dx / dist;
      move.z = dz / dist;
      // hedefe yaklaşırken yavaşla (titremeyi önler)
      if (dist < 0.8) {
        move.x *= dist / 0.8;
        move.z *= dist / 0.8;
      }
    }

    // Zıplama kararı: top yakında, raket menziline düşüyor (dev topa göre ölçekli)
    const horiz = Math.hypot(bp.x - p.x, bp.z - p.z);
    const vy = this.ball.body.velocity.y;
    const onOurSide = Math.sign(bp.x) === Math.sign(this.side);
    let jump = false;
    if (
      this.char.grounded() &&
      horiz < 0.9 + BALL.radius + this.jumpJitter &&
      bp.y > 1.5 + BALL.radius * 0.9 && bp.y < 3.1 + BALL.radius * 1.3 &&
      vy < 1.0 &&
      onOurSide
    ) {
      jump = true;
    }

    // Vuruş kararı: top raket menzilinde (yerde ya da havada) -> salınım başlat
    const swing =
      onOurSide &&
      horiz < 1.8 + BALL.radius &&
      bp.y > 1.0 && bp.y < 4.6;

    return { move, jump, swing };
  }

  _plan() {
    const landing = this._predictLanding();
    this.noise.x = (Math.random() - 0.5) * 0.5;
    this.noise.z = (Math.random() - 0.5) * 0.5;
    this.jumpJitter = (Math.random() - 0.5) * 0.3;

    if (landing && Math.sign(landing.x) === Math.sign(this.side)) {
      // Topun düşeceği noktanın hafif gerisinde dur ki kafa vuruşu fileye doğru gitsin
      this.target.x = clamp(
        landing.x + this.side * 0.35 + this.noise.x,
        Math.min(this.side * PLAYER.minX, this.side * PLAYER.maxX),
        Math.max(this.side * PLAYER.minX, this.side * PLAYER.maxX)
      );
      // Raket sağ elde: top raket tarafına denk gelsin diye hafif yana hizalan
      this.target.z = clamp(landing.z + this.side * 0.45 + this.noise.z, -PLAYER.maxZ, PLAYER.maxZ);
    } else {
      // Top bizim tarafa gelmiyor: ortada bekle
      this.target.x = this.home;
      this.target.z = this.ball.body.position.z * 0.3;
    }
  }

  // Basit ileri simülasyon: sürtünme + hafif yerçekimi ile top nereye düşecek?
  _predictLanding() {
    const b = this.ball.body;
    let px = b.position.x, py = b.position.y, pz = b.position.z;
    let vx = b.velocity.x, vy = b.velocity.y, vz = b.velocity.z;
    const h = PHYS_STEP * 4;
    const damp = Math.pow(1 - BALL.linearDamping, h);
    const targetY = 1.7 + BALL.radius; // dev topun vurulabilir merkez yüksekliği

    for (let t = 0; t < 3.5; t += h) {
      vy += BALL.effectiveGravity * h;
      vx *= damp; vy *= damp; vz *= damp;
      px += vx * h; py += vy * h; pz += vz * h;

      // duvar sekmeleri (kaba)
      if (px > COURT.wallX || px < -COURT.wallX) vx = -vx * 0.75;
      if (pz > COURT.wallZ || pz < -COURT.wallZ) vz = -vz * 0.75;
      // file sekmesi: alçaktan file tarafına geçemez
      if (py < COURT.netHeight && Math.sign(px) !== Math.sign(px - vx * h) && Math.abs(vx) > 0.01) {
        vx = -vx * 0.4;
      }

      if (py <= targetY && vy < 0) return { x: px, z: pz };
    }
    return null;
  }
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}
