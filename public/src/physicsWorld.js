import * as CANNON from 'cannon-es';
import { COURT, RACKET, WORLD_GRAVITY } from './constants.js';

// Çarpışma grupları
export const GROUP = { WORLD: 1, PLAYER: 2, BALL: 4, LIMB: 8, RACKET: 16 };

export function createPhysics() {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, WORLD_GRAVITY, 0) });
  world.solver.iterations = 12;
  world.allowSleep = false; // uyuyan gövde girdiyi yutmasın

  const mats = {
    ground: new CANNON.Material('ground'),
    ball: new CANNON.Material('ball'),
    player: new CANNON.Material('player'),
    net: new CANNON.Material('net'),
    wall: new CANNON.Material('wall'),
    racket: new CANNON.Material('racket'),
  };

  world.defaultContactMaterial.friction = 0.3;
  world.defaultContactMaterial.restitution = 0.2;

  world.addContactMaterial(new CANNON.ContactMaterial(mats.ground, mats.ball, { friction: 0.3, restitution: 0.8 }));
  world.addContactMaterial(new CANNON.ContactMaterial(mats.wall, mats.ball, { friction: 0.1, restitution: 0.95 }));
  world.addContactMaterial(new CANNON.ContactMaterial(mats.racket, mats.ball, { friction: 0.25, restitution: RACKET.restitution }));
  world.addContactMaterial(new CANNON.ContactMaterial(mats.net, mats.ball, { friction: 0.2, restitution: 0.4 }));
  world.addContactMaterial(new CANNON.ContactMaterial(mats.player, mats.ball, { friction: 0.1, restitution: 0.1 }));
  // Oyuncu hızı her karede kodla ayarlanıyor; zemin sürtünmesi yürüyüşü frenlemesin
  world.addContactMaterial(new CANNON.ContactMaterial(mats.ground, mats.player, { friction: 0, restitution: 0 }));

  // Zemin
  const ground = new CANNON.Body({ type: CANNON.Body.STATIC, shape: new CANNON.Plane(), material: mats.ground });
  ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  ground.gameTag = 'ground';
  world.addBody(ground);

  // File — top için katı bir duvar (oyuncular da geçemez)
  const net = new CANNON.Body({
    type: CANNON.Body.STATIC,
    shape: new CANNON.Box(new CANNON.Vec3(COURT.netThickness / 2, COURT.netHeight / 2, COURT.halfWidZ + 0.45)),
    position: new CANNON.Vec3(0, COURT.netHeight / 2, 0),
    material: mats.net,
  });
  net.gameTag = 'net';
  world.addBody(net);

  // Görünmez sınır duvarları — plastik top sahadan hiç çıkmaz.
  // wallInfo: çarpma efektinin hangi düzlemde, hangi yöne bakarak çizileceği
  const walls = [
    { he: [0.5, 20, 40], pos: [COURT.wallX + 0.5, 20, 0], axis: 'x', plane: COURT.wallX, n: [-1, 0, 0] },
    { he: [0.5, 20, 40], pos: [-COURT.wallX - 0.5, 20, 0], axis: 'x', plane: -COURT.wallX, n: [1, 0, 0] },
    { he: [40, 20, 0.5], pos: [0, 20, COURT.wallZ + 0.5], axis: 'z', plane: COURT.wallZ, n: [0, 0, -1] },
    { he: [40, 20, 0.5], pos: [0, 20, -COURT.wallZ - 0.5], axis: 'z', plane: -COURT.wallZ, n: [0, 0, 1] },
    { he: [40, 0.5, 40], pos: [0, COURT.ceilY + 0.5, 0], axis: 'y', plane: COURT.ceilY, n: [0, -1, 0] },
  ];
  for (const w of walls) {
    const body = new CANNON.Body({
      type: CANNON.Body.STATIC,
      shape: new CANNON.Box(new CANNON.Vec3(...w.he)),
      position: new CANNON.Vec3(...w.pos),
      material: mats.wall,
    });
    body.gameTag = 'wall';
    body.wallInfo = { axis: w.axis, plane: w.plane, normal: w.n };
    world.addBody(body);
  }

  return { world, mats };
}
