import * as THREE from 'three';
import { COURT, TEAM_COLORS } from './constants.js';

const SKY_BLUE = 0x87ceeb;
const GRASS = 0x57a63f;      // saha dışı çim yeşili
const COURT_BLUE = 0x1e6fb2; // sahanın koyu mavisi

// Sahne, kamera, ışıklar, saha, file, bulutlar
export function createGraphics(container, sideSign, teamNames = ['KIRMIZI', 'MAVİ']) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY_BLUE);
  scene.fog = new THREE.Fog(SKY_BLUE, 50, 140);

  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 260);
  camera.position.set(sideSign * 13.5, 6, 0);
  camera.lookAt(0, 1.0, 0);

  // Işıklar
  const hemi = new THREE.HemisphereLight(0xcfe9ff, 0x7db8dc, 1.15);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff2d8, 2.6);
  let sunAngle = Math.atan2(8, 10); // başlangıç azimutu (eski konumla aynı)
  sun.position.set(Math.cos(sunAngle) * 16, 20, Math.sin(sunAngle) * 16);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -26;
  sun.shadow.camera.right = 26;
  sun.shadow.camera.top = 26;
  sun.shadow.camera.bottom = -26;
  sun.shadow.camera.far = 70;
  sun.shadow.bias = -0.0004;
  scene.add(sun);

  // Zemin — saha DIŞI her yer çim yeşili
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(220, 220),
    new THREE.MeshStandardMaterial({ color: GRASS, roughness: 1, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Saha zemini — koyu mavi, kafesin içini kaplar (çim üstünde)
  const court = new THREE.Mesh(
    new THREE.PlaneGeometry(COURT.wallX * 2, COURT.wallZ * 2),
    new THREE.MeshStandardMaterial({ color: COURT_BLUE, roughness: 0.95, metalness: 0 })
  );
  court.rotation.x = -Math.PI / 2;
  court.position.y = 0.006;
  court.receiveShadow = true;
  scene.add(court);

  buildCourtLines(scene);
  buildNet(scene);
  buildFence(scene);       // sahayı yanlardan saran yeşil tel örgü (üst açık)
  buildBushes(scene);      // saha dışı çalılar/çim öbekleri
  const sunSprite = buildSunDisk(scene, sideSign);
  buildTeamBoards(scene, teamNames);
  const clouds = buildClouds(scene);
  const throwPreview = buildThrowPreview(scene);

  function resize() {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener('resize', resize);

  return {
    renderer,
    scene,
    camera,
    clouds,
    // Güneş yavaşça döner: gölgelerin yönü/şekli oyun boyunca değişir
    updateSun(dt) {
      sunAngle += dt * 0.012; // tam tur ~8.7 dakika
      sun.position.set(Math.cos(sunAngle) * 16, 20, Math.sin(sunAngle) * 16);
      // Gökyüzündeki güneş görseli de aynı azimutta süzülsün
      sunSprite.position.set(Math.cos(sunAngle) * 52, 25, Math.sin(sunAngle) * 52);
    },
    // Raket fırlatma yörünge önizlemesi: noktalar [x,y,z,x,y,z,...]
    showThrowPreview(pts) {
      const n = Math.floor(pts.length / 3);
      const pos = throwPreview.line.geometry.attributes.position;
      for (let i = 0; i < n; i++) {
        pos.setXYZ(i, pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
      }
      pos.needsUpdate = true;
      throwPreview.line.geometry.setDrawRange(0, n);
      throwPreview.line.visible = true;
      if (n > 0) {
        throwPreview.marker.position.set(pts[(n - 1) * 3], 0.05, pts[(n - 1) * 3 + 2]);
        throwPreview.marker.visible = true;
      }
    },
    hideThrowPreview() {
      throwPreview.line.visible = false;
      throwPreview.marker.visible = false;
    },
    dispose() {
      window.removeEventListener('resize', resize);
      renderer.dispose();
      renderer.forceContextLoss(); // menü<->oyun döngüsünde WebGL context birikmesin
      renderer.domElement.remove();
    },
  };
}

// Fırlatma yörüngesi: parlak noktalı çizgi + iniş halkası
function buildThrowPreview(scene) {
  const MAX = 46;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX * 3), 3));
  geo.setDrawRange(0, 0);
  const line = new THREE.Line(
    geo,
    new THREE.LineBasicMaterial({ color: 0xffe14d, transparent: true, opacity: 0.95 })
  );
  line.frustumCulled = false;
  line.visible = false;
  line.renderOrder = 5;
  scene.add(line);

  const marker = new THREE.Mesh(
    new THREE.RingGeometry(0.5, 0.85, 28),
    new THREE.MeshBasicMaterial({ color: 0xffe14d, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false })
  );
  marker.rotation.x = -Math.PI / 2;
  marker.visible = false;
  scene.add(marker);

  return { line, marker };
}

// Beyaz saha çizgileri
function buildCourtLines(scene) {
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const w = COURT.lineWidth;
  const L = COURT.halfLenX;
  const W = COURT.halfWidZ;
  const y = 0.012;

  const strips = [
    // kenar çizgileri (z sabit, x boyunca)
    { sx: L * 2 + w, sz: w, x: 0, z: W },
    { sx: L * 2 + w, sz: w, x: 0, z: -W },
    // dip çizgiler (x sabit)
    { sx: w, sz: W * 2 + w, x: L, z: 0 },
    { sx: w, sz: W * 2 + w, x: -L, z: 0 },
    // orta çizgi (filenin altı)
    { sx: w, sz: W * 2 + w, x: 0, z: 0 },
  ];

  for (const s of strips) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(s.sx, s.sz), mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(s.x, y, s.z);
    scene.add(m);
  }
}

// File: direkler + üst bant + ızgara dokulu ağ
function buildNet(scene) {
  const H = COURT.netHeight;
  const postZ = COURT.halfWidZ + 0.45;
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });

  for (const z of [postZ, -postZ]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, H + 0.2, 12), whiteMat);
    post.position.set(0, (H + 0.2) / 2, z);
    post.castShadow = true;
    scene.add(post);
  }

  const band = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, postZ * 2), whiteMat);
  band.position.set(0, H - 0.07, 0);
  band.castShadow = true;
  scene.add(band);

  // Ağ dokusu
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 128;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, 256, 128);
  g.strokeStyle = 'rgba(255,255,255,0.95)';
  g.lineWidth = 2.5;
  for (let x = 0; x <= 256; x += 16) {
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 128); g.stroke();
  }
  for (let y = 0; y <= 128; y += 16) {
    g.beginPath(); g.moveTo(0, y); g.lineTo(256, y); g.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(Math.max(4, Math.round(postZ)), 1);

  const netBottom = 0.95;
  const netMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(postZ * 2, H - 0.14 - netBottom),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide })
  );
  netMesh.rotation.y = Math.PI / 2;
  netMesh.position.set(0, (netBottom + H - 0.14) / 2, 0);
  scene.add(netMesh);
}

// Çevre çiti: tenis kortu tipi İNCE tel örgü (chain-link), çalı yeşili renkte.
// Yarı yükseklik, üst tamamen açık; örgü delikli GÖLGE düşürür.
const FENCE_GREEN = '#3f8a34';      // çalı yeşiliyle birebir aynı
const FENCE_POST_GREEN = 0x2c5f24;  // direkler biraz koyu
function buildFence(scene) {
  const X = COURT.wallX, Z = COURT.wallZ, H = COURT.fenceH;
  const postMat = new THREE.MeshStandardMaterial({ color: FENCE_POST_GREEN, roughness: 0.6, metalness: 0.3 });

  // Tel örgü duvar (ince baklava desen, delikli gölgeli)
  const addWall = (w, cx, cz, rotY) => {
    const t = makeChainLinkTexture();
    // İnce örgü: ~0.4m'de bir baklava hücresi
    t.repeat.set(Math.max(8, Math.round(w / 0.4)), Math.max(8, Math.round(H / 0.4)));
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, H),
      new THREE.MeshBasicMaterial({ map: t, transparent: true, side: THREE.DoubleSide, depthWrite: false, alphaTest: 0.15 })
    );
    m.position.set(cx, H / 2, cz);
    m.rotation.y = rotY;
    m.castShadow = true;
    // Delikli gölge: derinlik materyali de aynı örgü dokusunu kullansın
    m.customDepthMaterial = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking, map: t, alphaTest: 0.4,
    });
    scene.add(m);
  };
  addWall(Z * 2, X, 0, Math.PI / 2);   // +x duvar
  addWall(Z * 2, -X, 0, Math.PI / 2);  // -x duvar
  addWall(X * 2, 0, Z, 0);             // +z duvar
  addWall(X * 2, 0, -Z, 0);            // -z duvar

  // Direkler: köşeler + uzun kenarların ortaları (görseldeki gibi)
  const posts = [
    [X, Z], [X, -Z], [-X, Z], [-X, -Z], // köşeler
    [0, Z], [0, -Z],                     // uzun kenar ortaları
    [X, 0], [-X, 0],                     // kısa kenar ortaları
  ];
  for (const [cx, cz] of posts) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, H + 0.15, 10), postMat);
    post.position.set(cx, (H + 0.15) / 2, cz);
    post.castShadow = true;
    scene.add(post);
  }
  // Üst boru (tenis kortu çitlerindeki gibi ince ray)
  const rails = [
    { w: X * 2, x: 0, z: Z, rotY: 0 }, { w: X * 2, x: 0, z: -Z, rotY: 0 },
    { w: Z * 2, x: X, z: 0, rotY: Math.PI / 2 }, { w: Z * 2, x: -X, z: 0, rotY: Math.PI / 2 },
  ];
  for (const r of rails) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(r.w, 0.09, 0.09), postMat);
    rail.position.set(r.x, H, r.z);
    rail.rotation.y = r.rotY;
    rail.castShadow = true;
    scene.add(rail);
  }
}

// Tenis kortu tel örgüsü: ince baklava (chain-link) deseni, çalı yeşili
function makeChainLinkTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, 64, 64);
  g.strokeStyle = FENCE_GREEN;
  g.lineWidth = 4;
  // Baklava deseni: çapraz iki yönlü teller (kenarlardan taşarak dikişsiz döşenir)
  g.beginPath();
  g.moveTo(-32, 32); g.lineTo(32, -32);
  g.moveTo(0, 64); g.lineTo(64, 0);
  g.moveTo(32, 96); g.lineTo(96, 32);
  g.moveTo(-32, 32); g.lineTo(32, 96);
  g.moveTo(0, 0); g.lineTo(64, 64);
  g.moveTo(32, -32); g.lineTo(96, 32);
  g.stroke();
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// Saha dışı çalılar ve çim öbekleri (çim yeşilinin üstünde)
function buildBushes(scene) {
  const rng = mulberry32(1337);
  const bushMat = new THREE.MeshStandardMaterial({ color: 0x3f8a34, roughness: 1, flatShading: true });
  const bushMat2 = new THREE.MeshStandardMaterial({ color: 0x4fa441, roughness: 1, flatShading: true });
  const tuftMat = new THREE.MeshStandardMaterial({ color: 0x5bb04a, roughness: 1, flatShading: true });

  // Çalılar: birkaç küreden oluşan öbekler, kafesin dışına serpiştirilir
  for (let i = 0; i < 26; i++) {
    const group = new THREE.Group();
    const puffs = 2 + Math.floor(rng() * 3);
    for (let p = 0; p < puffs; p++) {
      const r = 0.9 + rng() * 1.3;
      const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), rng() < 0.5 ? bushMat : bushMat2);
      puff.position.set((rng() - 0.5) * 2.2, r * 0.55, (rng() - 0.5) * 2.2);
      puff.scale.y = 0.8;
      puff.castShadow = true;
      group.add(puff);
    }
    placeOutside(group, rng);
    scene.add(group);
  }

  // Çim öbekleri: küçük yeşil koniler
  for (let i = 0; i < 40; i++) {
    const tuft = new THREE.Group();
    for (let b = 0; b < 4; b++) {
      const blade = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.7 + rng() * 0.4, 4), tuftMat);
      blade.position.set((rng() - 0.5) * 0.5, 0.35, (rng() - 0.5) * 0.5);
      blade.rotation.z = (rng() - 0.5) * 0.4;
      tuft.add(blade);
    }
    placeOutside(tuft, rng);
    scene.add(tuft);
  }
}

// Nesneyi kafesin dışına, çim alanına rastgele yerleştir
function placeOutside(obj, rng) {
  let x, z;
  do {
    x = (rng() - 0.5) * 90;
    z = (rng() - 0.5) * 70;
  } while (Math.abs(x) < COURT.wallX + 2.5 && Math.abs(z) < COURT.wallZ + 2.5);
  obj.position.set(x, 0, z);
  obj.rotation.y = rng() * Math.PI * 2;
}

// Güneş — her iki kameradan da görünür şekilde sahanın karşısında
function buildSunDisk(scene, sideSign) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 8, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,250,210,1)');
  grad.addColorStop(0.45, 'rgba(255,240,170,0.9)');
  grad.addColorStop(1, 'rgba(255,240,170,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(cv);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
  sprite.scale.set(13, 13, 1);
  sprite.position.set(-sideSign * 48, 26, -20);
  scene.add(sprite);
  return sprite;
}

// Saha dışı takım panoları: her takımın çok arkasında, uzun beyaz direğin
// tepesinde siyah bir LED ekran; isimler yeşil led ışığı gibi yanar.
function buildTeamBoards(scene, names) {
  const poleMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.5, metalness: 0.3 });
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.6 });
  const boardW = 11, boardH = 3.6, poleH = 9.5, screenY = poleH + boardH / 2;

  for (let team = 0; team < 2; team++) {
    const sign = team === 0 ? -1 : 1; // takım 0 -> x<0 sahası, takım 1 -> x>0
    const x = sign * (COURT.halfLenX + 16); // görüşü kapatmasın diye çok arkada

    // Uzun beyaz direkler
    for (const dz of [-boardW / 2 + 0.8, boardW / 2 - 0.8]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, poleH, 14), poleMat);
      pole.position.set(x, poleH / 2, dz);
      pole.castShadow = true;
      scene.add(pole);
    }

    // Siyah çerçeve (ekranın arkası/kenarı)
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.4, boardH + 0.5, boardW + 0.5), frameMat);
    frame.position.set(x, screenY, 0);
    frame.castShadow = true;
    scene.add(frame);

    // Ekran — isim TAKIM RENGİNDE (kırmızı/mavi), parlamasız
    const teamColor = '#' + TEAM_COLORS[team].toString(16).padStart(6, '0');
    const tex = makeLedTexture(names[team] || (team === 0 ? 'KIRMIZI' : 'MAVİ'), teamColor);
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(boardW, boardH),
      new THREE.MeshBasicMaterial({ map: tex }) // MeshBasic: kendi ışığı gibi parlak
    );
    // +Z yüzü sahaya baksın (yazı düz okunsun): team0 -> +X, team1 -> -X
    screen.rotation.y = sign < 0 ? Math.PI / 2 : -Math.PI / 2;
    // Ekran çerçevenin SAHA tarafında dursun (çerçeve arkada, ekran görünür)
    screen.position.set(x - sign * 0.28, screenY, 0);
    scene.add(screen);
  }
}

function makeLedTexture(name, color = '#ffffff') {
  const cv = document.createElement('canvas');
  cv.width = 768;
  cv.height = 256;
  const g = cv.getContext('2d');
  // Siyah ekran
  g.fillStyle = '#050505';
  g.fillRect(0, 0, cv.width, cv.height);
  // Hafif LED nokta ızgarası
  g.fillStyle = 'rgba(255,255,255,0.03)';
  for (let y = 6; y < cv.height; y += 12) {
    for (let x = 6; x < cv.width; x += 12) g.fillRect(x, y, 2, 2);
  }
  // İsim — takım renginde, parlamasız (düz dolgu)
  const text = String(name).slice(0, 12).toUpperCase();
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = 'bold 150px "Baloo 2", Arial, sans-serif';
  g.fillStyle = color;
  g.fillText(text, cv.width / 2, cv.height / 2 + 8);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// Tombul bulutlar
function buildClouds(scene) {
  const clouds = [];
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: false });
  const rng = mulberry32(42);

  for (let i = 0; i < 7; i++) {
    const group = new THREE.Group();
    const puffs = 3 + Math.floor(rng() * 3);
    for (let p = 0; p < puffs; p++) {
      const r = 0.9 + rng() * 1.4;
      const puff = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), mat);
      puff.position.set((p - puffs / 2) * (r * 0.95), (rng() - 0.5) * 0.7, (rng() - 0.5) * 1.2);
      puff.scale.y = 0.65;
      group.add(puff);
    }
    const angle = rng() * Math.PI * 2;
    const dist = 28 + rng() * 22;
    group.position.set(Math.cos(angle) * dist, 9.5 + rng() * 5.5, Math.sin(angle) * dist);
    group.userData.speed = 0.12 + rng() * 0.2;
    scene.add(group);
    clouds.push(group);
  }
  return clouds;
}

export function updateClouds(clouds, dt) {
  for (const c of clouds) {
    c.position.z += c.userData.speed * dt;
    if (c.position.z > 58) c.position.z = -58;
  }
}

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
