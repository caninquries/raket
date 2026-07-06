// Oyun ayarları — tüm fizik ve saha ölçüleri burada
export const WORLD_GRAVITY = -18; // oyuncular için zıplama hissi veren yüksek yerçekimi

export const COURT = {
  halfLenX: 13,     // sahanın yarı uzunluğu (file X=0'da) — dev top/rakete göre uzatıldı
  halfWidZ: 8.5,    // sahanın yarı genişliği
  wallX: 16.5,      // görünmez duvarlar (top hep oyunda kalsın)
  wallZ: 10.5,
  ceilY: 15,
  netHeight: 2.35,
  netThickness: 0.12,
  lineWidth: 0.12,
};

export const PLAYER = {
  mass: 5,
  restY: 0.95,       // gövde merkezinin yerdeki yüksekliği
  speed: 7.4,
  accel: 14,         // hıza yaklaşma oranı (1/sn)
  jumpVel: 7.6,
  landRecoverTime: 1.0, // zıplama inişinden sonra yerde baygın kalma süresi
  minX: 0.7,         // fileye en fazla bu kadar yaklaşabilir
  maxX: 16,
  maxZ: 9.8,
  spawnX: 7.5,       // raund başı dizilme mesafesi (servis noktasından biraz geride)
  hitCooldown: 0.25,
  hitPower: 11,
  smashBonus: 5,
  steerPower: 4.0,   // basılı yön tuşlarının vuruşa etkisi
  upMin: 5.2,        // normal vuruşta topun minimum dikey hızı
  towardNet: 3.2,    // vuruşun rakip sahaya doğru doğal eğilimi
  staggerTime: 1.15, // vuruş sonrası geri tepme ragdoll'undan ayağa kalkma süresi
};

export const BALL = {
  radius: 1.0,           // DEV top — çapı (2m) karakterden (1.9m) bile büyük
  mass: 0.25,
  linearDamping: 0.09,   // hava sürtünmesi — plastik top havada yavaşlar
  effectiveGravity: -9.5, // başta düz gider, sonra yer çekimiyle belirgin şekilde düşer
  maxSpeed: 28,          // fiziksel raket vuruşları çok sert olabilir
  serveHeight: 9,
  serveX: 5,
};

// Dev raket: kafası topla aynı boyutta, GERÇEK fizik yüzeyi.
// Top rakete çarpar; yön tamamen temas açısı + raketin hareketiyle belirlenir.
export const RACKET = {
  swingDur: 0.6,      // Space ile zıplayınca yapılan salınımın süresi (sn)
  restitution: 1.0,   // raket yüzeyinin sekme gücü (dinlenirken top kontrolü)
  strikeStart: 0.17,  // vuruş penceresi: yüzeyin öne baktığı süpürüş aralığı;
  strikeEnd: 0.36,    // geriye kurulma ve geri dönüş fazları topa çarpamaz
  rehitCooldown: 1.0, // ilk temastan sonra raket bu süre topa tekrar vuramaz
  hitSpeed: 23,       // vuruş gücü (artırıldı) — baktığın yöne sert gider
  hitArc: 0.4,        // vuruşun yukarı kavisi (fileyi aşsın, sonra düşsün)
  throwSpeed: 20,     // sağ tıkla fırlatılan raket bu hızda uçar (~top hızı)
  throwUp: 0.5,       // fırlatmanın yukarı bileşeni (kavis)
  returnDelay: 1.0,   // raket YERDE DURDUKTAN sonra ele dönmeden önceki bekleme (sn)
  returnDur: 0.35,    // ele dönüş animasyon süresi (sn)
};

export const PHYS_STEP = 1 / 120;
export const WIN_SCORE = 7;
export const TEAM_COLORS = [0xff4d4d, 0x2f6bff];
export const TEAM_DARK = [0xc93636, 0x1f4fc4];
export const TEAM_NAMES = ['KIRMIZI', 'MAVİ'];
export const SIDE_SIGN = [-1, 1]; // takım 0 -> x<0 sahası, takım 1 -> x>0
