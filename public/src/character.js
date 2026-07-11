import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { BALL, PLAYER, RACKET, TEAM_COLORS, TEAM_DARK, SIDE_SIGN } from './constants.js';
import { GROUP } from './physicsWorld.js';

const SKIN = 0xfff1dd;
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _rq2 = new THREE.Quaternion();
const _reuler = new THREE.Euler();
const _up = new THREE.Vector3(0, 1, 0);
// Kafa (disk) çerçevesi = pivot çerçevesi +90° X. Uçarken görseli fizikten kurar.
const _headLocalQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
const _headLocalQInv = _headLocalQ.clone().invert();
const _dropDir = new THREE.Vector3();
const _holdAxis = new THREE.Vector3(0, 1, 1).normalize();

// Human Fall Flat tarzı tombul karakter:
// - Ana gövde: dik duran tek rijit cisim (devrilmez -> kontrol her zaman sağlam)
// - Kollar: gerçek fizikle sallanan sarkaçlar (ragdoll hissi)
// - Bacaklar: prosedürel yürüme animasyonu
// - Sayı yenince: gövde kilidi açılır, karakter komik şekilde yere yığılır (tam ragdoll)
export class Character {
  constructor({ scene, world, mats, team, isProxy = false }) {
    this.scene = scene;
    this.world = world;
    this.team = team;
    this.side = SIDE_SIGN[team];
    this.isProxy = isProxy;
    this.flopped = false;
    this.jumpTumble = false; // zıplama dalışı: rotasyon serbest ama kontrol/vuruş çalışır
    this.swingT = -1;        // raket salınımı: -1 = beklemede, >=0 = animasyon zamanı
    this.wantHold = false;   // sol tık basılı: vuruştan sonra diski düz tut (dish)
    this.holdPose = false;   // dish modu aktif mi
    this.holdPitch = 0.5;    // dish yüksekliği için nişan (fare) değeri
    this.racketCooldownUntil = 0;   // bu ana kadar raket topa vuramaz (tekrar-vuruş engeli)
    this._racketTouchedSwing = false;
    this._opacity = 1;          // yakın kamerada kendi karakterini soldurmak için
    this.racketState = 'held';  // 'held' | 'flying' | 'returning'
    this._rightArmFree = false; // fırlatınca sağ kol serbest sarkaç olur
    this._restTimer = 0;        // uçan raketin durgun geçirdiği süre
    this._flightTime = 0;       // fırlatmadan bu yana uçuş süresi (ilk anda kendine çarpmasın)
    this._returnTimer = 0;
    this._lastRacketBonk = -1;  // aynı fırlatmayla çift savurma engeli
    this._returnFromPos = new THREE.Vector3();
    this._returnFromQuat = new THREE.Quaternion();
    this.staggerUntil = 0; // >0 ise geçici geri tepme ragdoll'u, süresi dolunca ayağa kalkar
    this.moveInput = { x: 0, z: 0 };
    this.faceYaw = null; // null: hareket yönüne dön (bot); sayı: fare-bakış yönü (oyuncu)
    this.lastHit = -1;
    this.walkPhase = 0;
    this.yaw = this.side > 0 ? -Math.PI / 2 : Math.PI / 2;

    // Uzak oyuncu için ağdan gelen hedef durum
    this.netTarget = null;

    this._buildBody(mats);
    this._buildArms();
    this._buildVisual();
    this._buildRacketBody(mats);
    this.resetPose(this.side * PLAYER.spawnX, 0);
  }

  // Raket kafası GERÇEK bir fizik yüzeyi: top içinden geçmez, üzerinden seker.
  // Kinematik gövde her kare görsel raketin dünya konumuna taşınır; hızı da
  // ayarlanır ki salınım sırasında topa gerçek momentum aktarsın.
  _buildRacketBody(mats) {
    const R = BALL.radius * 1.28; // fizik yüzeyi görselden biraz geniş: isabet affedici
    const body = new CANNON.Body({
      type: CANNON.Body.KINEMATIC,
      mass: 0,
      shape: new CANNON.Cylinder(R, R, 0.16, 18), // disk (yüz) — kafa çerçevesinde origin
      material: mats.racket,
      collisionFilterGroup: GROUP.RACKET,
      collisionFilterMask: GROUP.BALL,
      position: new CANNON.Vec3(this.side * PLAYER.spawnX, 2, 0),
    });
    // Sap — diskin kafa-Z yönünde 1.28 gerisinde, kalın silindir: raketin HER YERİ topla temas etsin
    const handleQuat = new CANNON.Quaternion();
    handleQuat.setFromEuler(Math.PI / 2, 0, 0); // silindir eksenini Y -> Z çevir
    body.addShape(new CANNON.Cylinder(0.14, 0.14, 0.85, 10), new CANNON.Vec3(0, 0, 1.28), handleQuat);
    body.gameTag = 'racket';
    body.charRef = this;
    // Salınım sırasında İLK temas: top, raket yüzeyinin O ANKİ normali yönünde
    // fırlar (yön = raketin fiziksel duruşu; kenar teması kaosu yok). Ardından
    // raket anında kapanır ki aynı salınımda ikinci çarpma yönü bozmasın.
    body.addEventListener('collide', (e) => {
      const ballBody = e.body;
      if (!ballBody || ballBody.gameTag !== 'ball' || this.swingT < 0) return;
      this._racketTouchedSwing = true;
      body.collisionFilterMask = 0;

      const forward = -this.side; // takım 0 -> +x, takım 1 -> -x
      let dx, dy, dz;
      if (this.faceYaw !== null) {
        // OYUNCU: top ekranın ortasına (baktığın yatay yöne) + kavisle gider
        dx = Math.sin(this.faceYaw);
        dz = Math.cos(this.faceYaw);
        if (dx * forward < 0.05) dx = forward * 0.05; // asla kendi sahana gitmesin
        const h = Math.hypot(dx, dz) || 1;
        dx /= h; dz /= h;
        dy = RACKET.hitArc;
      } else {
        // BOT: raket yüzey normali (topa bakan taraf), karşı sahaya kilitli
        const n = body.quaternion.vmult(new CANNON.Vec3(0, 1, 0));
        const toBall = ballBody.position.vsub(body.position);
        if (n.dot(toBall) < 0) n.scale(-1, n);
        if (n.x * forward < 0.15) n.x = forward * 0.15;
        dx = n.x; dz = n.z; dy = Math.max(n.y, RACKET.hitArc);
      }
      const len = Math.hypot(dx, dy, dz) || 1;
      dx /= len; dy /= len; dz /= len;
      const speed = RACKET.hitSpeed;
      ballBody.velocity.set(dx * speed, dy * speed, dz * speed);
      ballBody.angularVelocity.set(-dz * 6, 0, dx * 6);
    });
    this.world.addBody(body);
    this.racketBody = body;
  }

  _buildBody(mats) {
    const type = this.isProxy ? CANNON.Body.KINEMATIC : CANNON.Body.DYNAMIC;
    const body = new CANNON.Body({
      mass: this.isProxy ? 0 : PLAYER.mass,
      type,
      material: mats.player,
      fixedRotation: true,
      linearDamping: 0.02,
      collisionFilterGroup: GROUP.PLAYER,
      collisionFilterMask: GROUP.WORLD | GROUP.BALL | GROUP.RACKET, // fırlatılan raket oyuncuyu vurabilsin
      position: new CANNON.Vec3(this.side * PLAYER.spawnX, PLAYER.restY, 0),
    });
    body.addShape(new CANNON.Sphere(0.2), new CANNON.Vec3(0, -0.75, 0));  // ayaklar
    body.addShape(new CANNON.Sphere(0.45), new CANNON.Vec3(0, 0, 0));     // gövde
    body.addShape(new CANNON.Sphere(0.32), new CANNON.Vec3(0, 0.66, 0));  // kafa
    body.gameTag = 'player';
    body.charRef = this;
    this.world.addBody(body);
    this.body = body;
  }

  _buildArms() {
    // Her kol: omuza nokta bağıyla asılı minik bir kütle — serbestçe sallanır
    this.armPivots = [new CANNON.Vec3(-0.46, 0.28, 0), new CANNON.Vec3(0.46, 0.28, 0)];
    this.armBodies = [];
    this.armConstraints = [];
    for (const pivot of this.armPivots) {
      const arm = new CANNON.Body({
        mass: 0.06,
        shape: new CANNON.Sphere(0.08),
        linearDamping: 0.85, // kollar aşırı sallanmasın
        collisionFilterGroup: GROUP.LIMB,
        collisionFilterMask: 0, // dekoratif: hiçbir şeyle çarpışmaz
        position: new CANNON.Vec3(
          this.body.position.x + pivot.x,
          this.body.position.y + pivot.y - 0.3,
          this.body.position.z
        ),
      });
      this.world.addBody(arm);
      const c = new CANNON.PointToPointConstraint(this.body, pivot, arm, new CANNON.Vec3(0, 0.3, 0));
      this.world.addConstraint(c);
      this.armBodies.push(arm);
      this.armConstraints.push(c);
    }
  }

  _buildVisual() {
    const color = TEAM_COLORS[this.team];
    const dark = TEAM_DARK[this.team];
    const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
    const darkMat = new THREE.MeshStandardMaterial({ color: dark, roughness: 0.7 });
    const skinMat = new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.65 });
    const blackMat = new THREE.MeshStandardMaterial({ color: 0x222233, roughness: 0.5 });
    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });

    const group = new THREE.Group();
    this.scene.add(group);
    this.group = group;

    // Gövde
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.5, 6, 20), bodyMat);
    torso.castShadow = true;
    group.add(torso);

    // Kafa + yüz
    const head = new THREE.Group();
    head.position.set(0, 0.66, 0);
    group.add(head);
    this.head = head;

    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.32, 24, 18), skinMat);
    skull.castShadow = true;
    head.add(skull);

    // Şapka (takım rengi)
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(0.335, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.42),
      bodyMat
    );
    cap.rotation.x = -0.15;
    head.add(cap);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.19, 0.035, 16), bodyMat);
    brim.position.set(0, 0.16, 0.24);
    brim.rotation.x = -0.2;
    brim.scale.z = 1.5;
    head.add(brim);

    // Mutlu yüz
    this.faceHappy = new THREE.Group();
    head.add(this.faceHappy);
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), blackMat);
      eye.position.set(sx * 0.115, 0.03, 0.285);
      this.faceHappy.add(eye);
      const glint = new THREE.Mesh(new THREE.SphereGeometry(0.016, 8, 6), whiteMat);
      glint.position.set(sx * 0.1, 0.055, 0.325);
      this.faceHappy.add(glint);
      const cheek = new THREE.Mesh(
        new THREE.SphereGeometry(0.05, 10, 8),
        new THREE.MeshStandardMaterial({ color: 0xffa8a8, roughness: 1 })
      );
      cheek.position.set(sx * 0.2, -0.08, 0.235);
      cheek.scale.set(1, 0.7, 0.4);
      this.faceHappy.add(cheek);
    }
    const smile = new THREE.Mesh(new THREE.TorusGeometry(0.085, 0.017, 8, 14, Math.PI), blackMat);
    smile.position.set(0, -0.05, 0.3);
    smile.rotation.z = Math.PI;
    this.faceHappy.add(smile);

    // Sersem yüz (X gözler) — yığılınca
    this.faceDizzy = new THREE.Group();
    this.faceDizzy.visible = false;
    head.add(this.faceDizzy);
    for (const sx of [-1, 1]) {
      for (const rot of [Math.PI / 4, -Math.PI / 4]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.02, 0.015), blackMat);
        bar.position.set(sx * 0.115, 0.035, 0.3);
        bar.rotation.z = rot;
        this.faceDizzy.add(bar);
      }
    }
    const ooo = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.016, 8, 14), blackMat);
    ooo.position.set(0, -0.08, 0.295);
    this.faceDizzy.add(ooo);

    // Bacaklar (prosedürel)
    this.legs = [];
    for (const sx of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(sx * 0.16, -0.5, 0);
      group.add(hip);
      const legMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.3, 4, 12), darkMat);
      legMesh.position.y = -0.24;
      legMesh.castShadow = true;
      hip.add(legMesh);
      const shoe = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 10), whiteMat);
      shoe.position.set(0, -0.44, 0.035);
      shoe.scale.set(1, 0.72, 1.35);
      shoe.castShadow = true;
      hip.add(shoe);
      this.legs.push(hip);
    }

    // Omuzlar — gövdeyle kol arasındaki boşluğu kapatır
    for (const sx of [-1, 1]) {
      const shoulder = new THREE.Mesh(new THREE.SphereGeometry(0.12, 14, 12), bodyMat);
      shoulder.position.set(sx * 0.44, 0.28, 0);
      shoulder.castShadow = true;
      group.add(shoulder);
    }

    // DEV RAKET — kafası topla aynı boyutta, SAĞ elde (karakter +Z'ye bakar,
    // sağ el = yerel -X tarafı) omuzdan sallanır
    const R = BALL.radius;
    const racketPivot = new THREE.Group();
    racketPivot.position.set(-0.44, 0.28, 0);
    racketPivot.rotation.x = -0.6; // dinlenme pozu: omuzda, hafif geride
    racketPivot.rotation.z = 0.2;
    group.add(racketPivot);
    this.racketPivot = racketPivot;

    // Sağ elin sapı kavradığı nokta — kol görseli buraya uzanır
    const grip = new THREE.Object3D();
    grip.position.set(0, 0.45, 0);
    racketPivot.add(grip);
    this.racketGrip = grip;

    const handleMat = new THREE.MeshStandardMaterial({ color: 0x9a6a3a, roughness: 0.8 });
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.55, 10), handleMat);
    handle.position.y = 0.27;
    handle.castShadow = true;
    racketPivot.add(handle);

    const face = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 0.1, 30), bodyMat);
    face.rotation.x = Math.PI / 2; // disk yüzü karakterin önüne baksın
    face.position.y = 0.55 + R;
    face.castShadow = true;
    racketPivot.add(face);
    this.racketHead = face;

    const rim = new THREE.Mesh(new THREE.TorusGeometry(R, 0.06, 10, 36), whiteMat);
    rim.position.y = 0.55 + R;
    rim.castShadow = true;
    racketPivot.add(rim);

    // Kollar (fizikten güncellenir) — sahneye ayrı eklenir
    this.armMeshes = [];
    this.handMeshes = [];
    this.armLen = 0.52;
    for (let i = 0; i < 2; i++) {
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.085, this.armLen - 0.17, 4, 12), bodyMat);
      arm.castShadow = true;
      this.scene.add(arm);
      this.armMeshes.push(arm);
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.095, 12, 10), skinMat);
      hand.castShadow = true;
      this.scene.add(hand);
      this.handMeshes.push(hand);
    }
  }

  // --- Kontrol (yalnızca yerel dinamik karakterde) ---
  applyControl(move, wantJump, dt, sfx) {
    if (this.flopped || this.isProxy) return;
    this.moveInput = { x: move.x, z: move.z };
    this.body.wakeUp();

    const v = this.body.velocity;

    // Havada (zıplama sonrası): yörünge değiştirilemez — zıplarken basılı olan
    // yöne fırlar ve öyle gider. Yön tuşları yalnızca kendi ekseninde döndürür.
    if (this.jumpTumble || !this.grounded()) {
      const len = Math.hypot(move.x, move.z);
      if (this.jumpTumble && len > 0.2) {
        const av = this.body.angularVelocity;
        const k = Math.min(1, 5 * dt);
        av.x += ((move.z / len) * 4.5 - av.x) * k;
        av.z += ((-move.x / len) * 4.5 - av.z) * k;
      }
      return;
    }

    const rate = Math.min(1, PLAYER.accel * dt);
    v.x += (move.x * PLAYER.speed - v.x) * rate;
    v.z += (move.z * PLAYER.speed - v.z) * rate;

    if (wantJump) {
      v.y = PLAYER.jumpVel;
      // Zıpladığı yöne kısa bir savrulma + ragdoll taklası (bayılma mekaniği sürüyor)
      v.x += move.x * 2.6;
      v.z += move.z * 2.6;
      this._startJumpTumble(move);
      if (sfx) sfx.jump();
    }
  }

  // --- Raket salınımı (artık sadece MANUEL: sol tık / bot kararı) ---
  startSwing() {
    if (this.swingT >= 0 || this.racketState !== 'held' || this.flopped) return;
    this.swingT = 0;
  }

  // Sayı/çarpma anında raketi elden düşür (rastgele yöne savrulur)
  dropRacket() {
    if (this.racketState !== 'held' || this.flopped) return;
    _dropDir.set((Math.random() - 0.5), 0.7 + Math.random() * 0.35, (Math.random() - 0.5)).normalize();
    this.throwRacket(_dropDir);
  }

  // --- Raket fırlatma (sağ tık) ---
  // dir: normalize edilmiş 3B yön (dünya). Raketi elden koparıp fizikle uçurur.
  throwRacket(dir) {
    if (this.racketState !== 'held' || this.flopped || this.holdPose) return; // dish'te fırlatma yok
    this.racketState = 'flying';
    this.swingT = -1;
    this._restTimer = 0;
    this._flightTime = 0;
    this._rightArmFree = true;
    this.armMeshes[0].scale.set(1, 1, 1);

    // Görsel raketi sahneye taşı; gövde = kafa (disk) çerçevesi (şekiller bu çerçevede)
    this.racketHead.getWorldPosition(_v1);    // disk dünya konumu
    this.racketHead.getWorldQuaternion(_q1);  // gövde yönü = kafa yönü
    this.scene.attach(this.racketPivot);

    // Fizik gövdesini dinamiğe çevir ve fırlat
    const b = this.racketBody;
    b.type = CANNON.Body.DYNAMIC;
    b.mass = 1.2;
    b.updateMassProperties();
    // Uçarken topu ve (ilk 0.15 sn hariç) oyuncuları vurur; ilk an kendine çarpmasın
    b.collisionFilterMask = GROUP.WORLD | GROUP.BALL;
    b.linearDamping = 0.05;
    b.angularDamping = 0.15;
    b.position.set(_v1.x, _v1.y, _v1.z);
    b.quaternion.set(_q1.x, _q1.y, _q1.z, _q1.w);
    b.velocity.set(dir.x * RACKET.throwSpeed, dir.y * RACKET.throwSpeed, dir.z * RACKET.throwSpeed);
    b.angularVelocity.set(
      (Math.random() - 0.5) * 6,
      (Math.random() - 0.5) * 4,
      6 + Math.random() * 4
    );
    b.wakeUp();
  }

  _updateFlying(dt) {
    const b = this.racketBody;
    // İlk 0.15 sn sadece dünya+top ile çarpış (kendine çarpmasın), sonra oyuncuları da vur
    this._flightTime += dt;
    if (this._flightTime > 0.15) {
      b.collisionFilterMask = GROUP.WORLD | GROUP.BALL | GROUP.PLAYER;
    }

    // Görseli fizikten kur: gövde=kafa çerçevesi -> pivot = bodyQuat * inv(kafaLokal)
    _q1.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
    this.racketPivot.quaternion.copy(_q1).multiply(_headLocalQInv);
    _v2.set(0, 0.55 + BALL.radius, 0).applyQuaternion(this.racketPivot.quaternion);
    this.racketPivot.position.set(b.position.x - _v2.x, b.position.y - _v2.y, b.position.z - _v2.z);

    // Durgunlaşınca 1 sn say, sonra ele dön (kural: DURDUKTAN sonra başlar)
    const speed = b.velocity.length() + b.angularVelocity.length() * 0.3;
    if (speed < 1.2) {
      this._restTimer += dt;
      if (this._restTimer >= RACKET.returnDelay) this._startReturn();
    } else {
      this._restTimer = 0;
    }
  }

  _startReturn() {
    this.racketState = 'returning';
    this._returnTimer = 0;
    this._returnFromPos.copy(this.racketPivot.position);
    this._returnFromQuat.copy(this.racketPivot.quaternion);
    const b = this.racketBody;
    b.type = CANNON.Body.KINEMATIC;
    b.mass = 0;
    b.updateMassProperties();
    b.velocity.set(0, 0, 0);
    b.angularVelocity.set(0, 0, 0);
    b.collisionFilterMask = 0;
  }

  _updateReturning(dt) {
    this._returnTimer += dt;
    const t = Math.min(1, this._returnTimer / RACKET.returnDur);
    const e = t * t * (3 - 2 * t);
    // Hedef: elde olsaydı raketin sahip olacağı dünya pozu
    _v1.set(-0.44, 0.28, 0);
    this.group.localToWorld(_v1);
    _rq2.setFromEuler(_reuler.set(-0.6, 0, 0.2));
    this.group.getWorldQuaternion(_q1);
    _rq2.premultiply(_q1);
    this.racketPivot.position.lerpVectors(this._returnFromPos, _v1, e);
    this.racketPivot.quaternion.copy(this._returnFromQuat).slerp(_rq2, e);
    // Fizik gövdesini görselle taşı
    const b = this.racketBody;
    b.position.set(this.racketPivot.position.x, this.racketPivot.position.y, this.racketPivot.position.z);
    if (t >= 1) this._finishReturn();
  }

  _finishReturn() {
    this.group.add(this.racketPivot); // tekrar ele bağla
    this.racketPivot.position.set(-0.44, 0.28, 0);
    this.racketPivot.rotation.set(-0.6, 0, 0.2);
    this.racketPivot.scale.set(1, 1, 1);
    this._rightArmFree = false;
    this.racketState = 'held';
    this.racketCooldownUntil = 0;
    this._racketTouchedSwing = false;
    const b = this.racketBody;
    b.collisionFilterMask = GROUP.BALL;
  }

  _updateRacket(dt) {
    if (this.racketState === 'flying') { this._updateFlying(dt); return; }
    if (this.racketState === 'returning') { this._updateReturning(dt); return; }

    // DISH modu: sol tık basılıyken vuruştan sonra diski düz (yukarı bakar) tut
    if (this.holdPose) {
      if (!this.wantHold || this.flopped || this.jumpTumble) {
        this.holdPose = false;
        this.racketPivot.rotation.set(-0.6, 0, 0.2); // rest euler'e dön (quaternion temizlensin)
        this.racketPivot.position.set(-0.44, 0.28, 0);
      } else {
        this._applyHoldPose();
        return;
      }
    }

    if (this.swingT >= 0) {
      this.swingT += dt;
      // Sol tık basılı + raket ÖNE savruldu (strike) -> HEMEN dish'e geç.
      // Böylece vuruş öne savrulması ile diski düz tutma tek hareket olur.
      if (this.wantHold && !this.flopped && !this.jumpTumble && this.swingT >= RACKET.strikeEnd) {
        this.holdPose = true;
        this.swingT = -1;
        this._applyHoldPose();
        return;
      }
      if (this.swingT >= RACKET.swingDur) {
        this.swingT = -1;
      } else {
        // Anahtar kareler: dinlenme -> geriye kurul -> ÖNE UZANARAK ÇAK -> dinlenme.
        // Strike +1.35 = raket daha ileriye savrulur (daha uzağa uzanır).
        const keys = [
          [0, -0.6],
          [0.08, -2.4],
          [RACKET.strikeEnd, 1.35],
          [RACKET.swingDur, -0.6],
        ];
        for (let i = 0; i < keys.length - 1; i++) {
          if (this.swingT <= keys[i + 1][0]) {
            const u = (this.swingT - keys[i][0]) / (keys[i + 1][0] - keys[i][0]);
            const e = u * u * (3 - 2 * u); // smoothstep
            this.racketPivot.rotation.x = keys[i][1] + (keys[i + 1][1] - keys[i][1]) * e;
            break;
          }
        }
        return;
      }
    }
    // Dinlenme pozuna yumuşakça dön
    this.racketPivot.rotation.x += (-0.6 - this.racketPivot.rotation.x) * Math.min(1, 8 * dt);
  }

  // Servis hazırlığı: karakteri fileye döndür, dish pozunu HEMEN uygula ve
  // topun oturacağı disk-üstü noktayı döndür (top raund başında burada hazır durur)
  prepareServeDish(out) {
    this.yaw = Math.atan2(-this.side, 0); // fileye bak
    this.group.position.copy(this.body.position);
    this.group.quaternion.setFromAxisAngle(_up, this.yaw);
    this.wantHold = true;
    this.holdPose = true;
    this._applyHoldPose();
    this.group.updateMatrixWorld(true);
    this.racketHead.getWorldPosition(out);
    out.y += BALL.radius + 0.05;
    return out;
  }

  // Dish pozu: disk YUKARI baksın ve karakterin ÖNÜNDE SABİT dursun (topu ortasında taşır).
  // Kameradan bağımsız — sağ kol omuzdan sapa uzanır (görsel arm koduyla yerleşir).
  _applyHoldPose() {
    // pivot Y -> grup +Z (ileri), pivot Z -> grup +Y (yukarı): (0,1,1) ekseninde 180°
    this.racketPivot.quaternion.setFromAxisAngle(_holdAxis, Math.PI);
    this.racketPivot.position.set(-0.32, 0.5, 0); // sağ omuz önünde sabit
  }

  // Zıplarken rotasyon kilidi açılır: karakter yöne doğru hafifçe takla atar.
  // flopped DEĞİL — havada kontrol ve topa vuruş çalışmaya devam eder.
  _startJumpTumble(move) {
    if (this.flopped || this.jumpTumble) return;
    this.jumpTumble = true;
    const b = this.body;
    b.fixedRotation = false;
    b.updateMassProperties();
    // Görsel süreklilik: fizik gövdesi o anki bakış yönünden tumble'a başlasın
    b.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), this.yaw);
    const len = Math.hypot(move.x, move.z);
    if (len > 0.2) {
      // İleri dalış: dönme ekseni = yukarı x hareket yönü
      b.angularVelocity.set((move.z / len) * 2.6, 0, -(move.x / len) * 2.6);
    } else {
      b.angularVelocity.set(
        (Math.random() - 0.5) * 1.2, 0, (Math.random() - 0.5) * 1.2
      );
    }
  }

  // Zıplama inişi: hemen kalkma — bir süre yerde baygın yat, sonra kendine gel.
  // (Ayağa kalkma Game'deki stagger kontrolüyle staggerUntil üzerinden olur.)
  downFor(now, duration) {
    this.jumpTumble = false;
    this.flopped = true;
    this.swingT = -1;
    this.staggerUntil = now + duration;
    this.body.linearDamping = 0.6; // yerde kayarak dursun
    this.faceHappy.visible = false;
    this.faceDizzy.visible = true;
  }

  grounded() {
    return this.body.position.y <= PLAYER.restY + 0.06 && this.body.velocity.y <= 0.5;
  }

  inAir() {
    return this.body.position.y > PLAYER.restY + 0.25;
  }

  // Sahasının dışına / filenin öbür tarafına geçmesin
  clampToSide() {
    if (this.flopped) return;
    const p = this.body.position;
    const v = this.body.velocity;
    const s = this.side;
    const lo = s > 0 ? PLAYER.minX : -PLAYER.maxX;
    const hi = s > 0 ? PLAYER.maxX : -PLAYER.minX;
    if (p.x < lo) { p.x = lo; if (v.x < 0) v.x = 0; }
    if (p.x > hi) { p.x = hi; if (v.x > 0) v.x = 0; }
    if (p.z < -PLAYER.maxZ) { p.z = -PLAYER.maxZ; if (v.z < 0) v.z = 0; }
    if (p.z > PLAYER.maxZ) { p.z = PLAYER.maxZ; if (v.z > 0) v.z = 0; }
  }

  // Uzak oyuncuyu ağ hedefine doğru yumuşakça taşı
  applyNetTarget(dt) {
    if (!this.isProxy || !this.netTarget || this.flopped) return;
    const t = this.netTarget;
    const p = this.body.position;
    const k = 1 - Math.exp(-14 * dt);
    p.x += (t.p[0] - p.x) * k;
    p.y += (t.p[1] - p.y) * k;
    p.z += (t.p[2] - p.z) * k;
    this.body.velocity.set(t.v[0], t.v[1], t.v[2]);
    this.moveInput = { x: t.m[0], z: t.m[1] };
  }

  // --- Komik yığılma: sayıyı yiyen takım ragdoll olur ---
  flop() {
    if (this.flopped) return;
    this.flopped = true;
    this.jumpTumble = false;
    this.swingT = -1;
    this.holdPose = false;
    this.staggerUntil = 0;
    const b = this.body;
    b.type = CANNON.Body.DYNAMIC;
    b.mass = PLAYER.mass;
    b.fixedRotation = false;
    b.updateMassProperties();
    b.linearDamping = 0.35; // sürtünmesiz zeminde ragdoll sonsuza kaymasın
    b.wakeUp();
    b.velocity.y += 2.5;
    b.angularVelocity.set(
      (Math.random() - 0.5) * 8,
      (Math.random() - 0.5) * 4,
      (Math.random() - 0.5) * 8
    );
    this.faceHappy.visible = false;
    this.faceDizzy.visible = true;
  }

  // Vuruş sonrası geri tepme: kısa süreliğine ragdoll, sonra kendiliğinden kalkar
  stagger(nowSec) {
    this.flop();
    this.staggerUntil = nowSec + PLAYER.staggerTime;
  }

  // Bulunduğu yerde ayağa kalk (raund devam ederken)
  recoverInPlace() {
    const p = this.body.position;
    const s = this.side;
    const lo = s > 0 ? PLAYER.minX : -PLAYER.maxX;
    const hi = s > 0 ? PLAYER.maxX : -PLAYER.minX;
    const x = Math.max(lo, Math.min(hi, p.x));
    const z = Math.max(-PLAYER.maxZ, Math.min(PLAYER.maxZ, p.z));
    this.resetPose(x, z);
  }

  resetPose(x, z) {
    const b = this.body;
    b.type = this.isProxy ? CANNON.Body.KINEMATIC : CANNON.Body.DYNAMIC;
    b.mass = this.isProxy ? 0 : PLAYER.mass;
    b.fixedRotation = true;
    b.updateMassProperties();
    b.position.set(x, PLAYER.restY, z);
    b.velocity.set(0, 0, 0);
    b.angularVelocity.set(0, 0, 0);
    b.quaternion.set(0, 0, 0, 1);
    b.linearDamping = 0.02;
    b.wakeUp();
    this.flopped = false;
    this.jumpTumble = false;
    this.swingT = -1;
    this.holdPose = false;
    this.wantHold = false;
    this.staggerUntil = 0;
    this.faceHappy.visible = true;
    this.faceDizzy.visible = false;
    this.racketPivot.rotation.set(-0.6, 0, 0.2); // dish quaternion'ı temizle
    this.netTarget = null;
    this.moveInput = { x: 0, z: 0 };
    for (let i = 0; i < 2; i++) {
      const pivot = this.armPivots[i];
      this.armBodies[i].position.set(x + pivot.x, PLAYER.restY + pivot.y - 0.3, z);
      this.armBodies[i].velocity.set(0, 0, 0);
    }
    if (this.racketBody) {
      // Raket fırlatılmış/dönüyorsa: anında ele geri koy (raund sıfırlandı)
      if (this.racketState !== 'held') {
        if (this.racketPivot.parent !== this.group) this.group.add(this.racketPivot);
        this.racketPivot.position.set(-0.44, 0.28, 0);
        this.racketPivot.rotation.set(-0.6, 0, 0.2);
        this.racketPivot.scale.set(1, 1, 1);
        this.racketState = 'held';
        this._rightArmFree = false;
        const rb = this.racketBody;
        rb.type = CANNON.Body.KINEMATIC;
        rb.mass = 0;
        rb.updateMassProperties();
        rb.linearDamping = 0;
      }
      this.racketBody.position.set(x, 2, z);
      this.racketBody.velocity.set(0, 0, 0);
      this.racketBody.angularVelocity.set(0, 0, 0);
      this.racketBody.collisionFilterMask = GROUP.BALL;
      this.racketCooldownUntil = 0;
      this._racketTouchedSwing = false;
    }
  }

  // --- Görsel güncelleme ---
  update(dt, ballPos, now = 0) {
    const b = this.body;

    // Zıplama dalışından iniş: yere değince 1 sn baygın kal, sonra kalk
    if (this.jumpTumble && !this.flopped && b.velocity.y <= 0.2 && b.position.y <= PLAYER.restY + 0.12) {
      this.downFor(now, PLAYER.landRecoverTime);
    }

    this.group.position.copy(b.position);
    this._updateRacket(dt);

    if (this.flopped || this.jumpTumble) {
      // Tam ragdoll / dalış: fizik gövdesinin dönüşünü aynen uygula
      this.group.quaternion.copy(b.quaternion);
    } else {
      // Bakış yönü: oyuncuda fare-bakış (faceYaw), botta hareket yönü
      let targetYaw;
      if (this.faceYaw !== null) {
        targetYaw = this.faceYaw;
      } else {
        const m = this.moveInput;
        const moving = Math.hypot(m.x, m.z) > 0.2;
        targetYaw = moving ? Math.atan2(m.x, m.z) : Math.atan2(-this.side, 0);
      }
      this.yaw = lerpAngle(this.yaw, targetYaw, Math.min(1, 16 * dt));
      this.group.quaternion.setFromAxisAngle(_up, this.yaw);

      // Kafa topa baksın (sınırlı açı) — çok tatlı duruyor
      if (ballPos) {
        _v1.copy(ballPos).sub(this.group.position);
        const worldYawToBall = Math.atan2(_v1.x, _v1.z);
        let relYaw = normAngle(worldYawToBall - this.yaw);
        relYaw = THREE.MathUtils.clamp(relYaw, -0.75, 0.75);
        const dist = Math.hypot(_v1.x, _v1.z);
        const pitch = THREE.MathUtils.clamp(Math.atan2(_v1.y - 0.6, dist), -0.35, 0.5);
        this.head.rotation.y += (relYaw - this.head.rotation.y) * Math.min(1, 8 * dt);
        this.head.rotation.x += (-pitch - this.head.rotation.x) * Math.min(1, 8 * dt);
      }
    }

    // Bacak animasyonu
    const speed = Math.hypot(b.velocity.x, b.velocity.z);
    const grounded = this.grounded();
    if (this.flopped) {
      this.legs[0].rotation.x = lerp(this.legs[0].rotation.x, 0.5, 5 * dt);
      this.legs[1].rotation.x = lerp(this.legs[1].rotation.x, -0.3, 5 * dt);
    } else if (!grounded) {
      this.legs[0].rotation.x = lerp(this.legs[0].rotation.x, -0.85, 8 * dt);
      this.legs[1].rotation.x = lerp(this.legs[1].rotation.x, -0.45, 8 * dt);
    } else if (speed > 0.4) {
      this.walkPhase += speed * dt * 5.2;
      const amp = Math.min(0.75, speed * 0.14);
      this.legs[0].rotation.x = Math.sin(this.walkPhase) * amp;
      this.legs[1].rotation.x = Math.sin(this.walkPhase + Math.PI) * amp;
    } else {
      this.legs[0].rotation.x = lerp(this.legs[0].rotation.x, 0, 8 * dt);
      this.legs[1].rotation.x = lerp(this.legs[1].rotation.x, 0, 8 * dt);
    }

    // Kollar: omuz -> fizik sarkaç kütlesi arasına gerilir.
    // Omuz noktaları karakterin baktığı yöne göre döndürülür; yoksa gövde
    // görsel olarak dönerken kollar dünya ekseninde sabit kalırdı.
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    for (let i = 0; i < 2; i++) {
      if (i === 0 && !this._rightArmFree) {
        // Sağ kol raketi tutar: sarkaç değil — GERÇEK sağ OMUZDAN raketin sapına
        // (grip) rijit uzanır. Omuz sabit gövde noktası, grip raketle birlikte gider
        // (dish modunda bile omuza bağlı kalır ve görünür).
        const mesh = this.armMeshes[0];
        const hand = this.handMeshes[0];
        _v1.set(-0.44, 0.28, 0);
        this.group.localToWorld(_v1); // sağ omuz dünya konumu
        this.racketGrip.getWorldPosition(_v2); // sapın kavrama noktası
        _v3.copy(_v2).sub(_v1);
        let glen = _v3.length();
        if (glen < 0.001) { _v3.set(0, -1, 0); glen = 1; }
        _v3.normalize();
        mesh.position.copy(_v1).addScaledVector(_v3, glen * 0.5);
        mesh.quaternion.setFromUnitVectors(_up, _v3);
        mesh.scale.y = glen / this.armLen;
        hand.position.copy(_v2);
        continue;
      }

      const base = this.armPivots[i];
      const c = this.armConstraints[i];
      if (this.flopped || this.jumpTumble) {
        c.pivotA.set(base.x, base.y, base.z); // gövde gerçekten dönüyor: pivot gövde çerçevesinde
      } else {
        // Y ekseni etrafında yaw kadar döndür (gövde fiziği hep kimlik dönüşünde)
        c.pivotA.set(base.x * cy + base.z * sy, base.y, -base.x * sy + base.z * cy);
      }
      const shoulder = b.quaternion.vmult(c.pivotA);
      _v1.set(b.position.x + shoulder.x, b.position.y + shoulder.y, b.position.z + shoulder.z);
      // Kol kütlesi gövde hızına bağlansın: aşırı sallanmayı keser
      const k = Math.min(1, 5 * dt);
      const av = this.armBodies[i].velocity;
      av.x += (b.velocity.x - av.x) * k;
      av.y += (b.velocity.y - av.y) * k;
      av.z += (b.velocity.z - av.z) * k;
      const ab = this.armBodies[i].position;
      _v2.set(ab.x, ab.y, ab.z).sub(_v1);
      let len = _v2.length();
      if (len < 0.001) { _v2.set(0, -1, 0); len = 1; }
      _v2.normalize();

      const mesh = this.armMeshes[i];
      mesh.position.copy(_v1).addScaledVector(_v2, this.armLen * 0.5);
      mesh.quaternion.setFromUnitVectors(_up, _v3.copy(_v2).negate());
      const hand = this.handMeshes[i];
      hand.position.copy(_v1).addScaledVector(_v2, this.armLen);
    }

    // Salınımda topa değdiyse: 1 sn tekrar-vuruş yasağı başlat
    if (this._racketTouchedSwing) {
      this._racketTouchedSwing = false;
      this.racketCooldownUntil = now + RACKET.rehitCooldown;
    }

    // Raket elde değilse (uçuyor/dönüyor) kinematik takip yapma; fizik ayrı yürür
    if (this.racketState !== 'held') return;

    // Raket YERİN ve FİLENİN içine girmesin. Dünya-uzayı deltasını raket pivot'una
    // uygulayıp diski yukarı/geri kaydırırız. YER clamp'i her durumda (zıplarken,
    // bayılırken de) çalışır; FİLE clamp'i yalnızca dik dururken.
    if (!this.holdPose) {
      this.racketPivot.position.set(-0.44, 0.28, 0); // her kare dinlenme konumundan başla
    }
    this.racketHead.getWorldPosition(_v3);
    let ddx = 0, ddy = 0;
    const diskBottom = _v3.y - BALL.radius;
    if (diskBottom < 0.12) ddy = 0.12 - diskBottom; // yerin üstünde kalsın
    if (!this.flopped && !this.jumpTumble) {
      const fwdX = -this.side; // karşı saha x yönü (takım 0: +1)
      const overshoot = _v3.x * fwdX - BALL.radius * 0.3; // diski merkezi kendi sahada kalsın
      if (overshoot > 0) ddx = -fwdX * overshoot; // fileyi aşan kısmı geri çek
    }
    if (ddx !== 0 || ddy !== 0) {
      this.racketPivot.getWorldPosition(_v2);
      _v2.x += ddx; _v2.y += ddy;
      this.group.worldToLocal(_v2);
      this.racketPivot.position.copy(_v2);
    }

    // Raket her zaman KATI (top asla içinden geçmez), yalnızca tekrar-vuruş
    // yasağı sürerken kapalı. Salınımda ilk temasta collide handler devreye
    // girip topu yüzey normali yönünde ileri fırlatır ve raketi kapatır.
    // Dish modunda fiziksel çarpışma kapalı — topu beşik (cradle) scripti taşır
    this.racketBody.collisionFilterMask =
      (this.holdPose || now < this.racketCooldownUntil) ? 0 : GROUP.BALL;

    // Raket fizik gövdesini görsel raket kafasına taşı. Hız da veriliyor ki
    // salınım sırasında top gerçek momentumla, temas açısına göre fırlasın.
    this.racketHead.getWorldPosition(_v1);
    this.racketHead.getWorldQuaternion(_q1);
    const rb = this.racketBody;
    if (dt > 0.0001) {
      _v2.set(
        (_v1.x - rb.position.x) / dt,
        (_v1.y - rb.position.y) / dt,
        (_v1.z - rb.position.z) / dt
      );
      // Işınlanma (raund reseti vb.) tek karelik dev hız üretmesin
      if (_v2.length() > 60) _v2.set(0, 0, 0);
      rb.velocity.set(_v2.x, _v2.y, _v2.z);
    }
    rb.position.set(_v1.x, _v1.y, _v1.z);
    rb.quaternion.set(_q1.x, _q1.y, _q1.z, _q1.w);
  }

  // Kamera yaklaşınca kendi karakterini kademeli soldur (yalnızca yerel görünüm).
  // Elde raket (group içindeki racketPivot) da solar; fırlatılmış raket etkilenmez.
  setOpacity(o) {
    o = Math.max(0, Math.min(1, o));
    if (Math.abs((this._opacity ?? 1) - o) < 0.01) return;
    this._opacity = o;
    const transparent = o < 0.995;
    const shadow = o > 0.4;
    const apply = (root) => {
      root.traverse((n) => {
        if (!n.isMesh || !n.material) return;
        n.castShadow = shadow;
        const mats = Array.isArray(n.material) ? n.material : [n.material];
        for (const m of mats) { m.transparent = transparent; m.opacity = o; }
      });
    };
    apply(this.group); // gövde, kafa, bacaklar, omuzlar + elde raket (racketPivot)
    for (const m of this.armMeshes) apply(m);
    for (const m of this.handMeshes) apply(m);
  }

  dispose() {
    for (const c of this.armConstraints) this.world.removeConstraint(c);
    for (const a of this.armBodies) this.world.removeBody(a);
    this.world.removeBody(this.racketBody);
    this.world.removeBody(this.body);
    this.scene.remove(this.group);
    this.scene.remove(this.racketPivot); // fırlatılmışken sahneye bağlıysa temizle
    for (const m of this.armMeshes) this.scene.remove(m);
    for (const m of this.handMeshes) this.scene.remove(m);
  }
}

function lerp(a, b, t) {
  return a + (b - a) * Math.min(1, t);
}

function normAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function lerpAngle(a, b, t) {
  return a + normAngle(b - a) * t;
}
