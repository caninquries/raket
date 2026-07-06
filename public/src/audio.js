// Küçük WebAudio sentez efektleri — dosya gerekmez
let ctx = null;

export function initAudio() {
  if (!ctx) {
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      /* ses yoksa oyun sessiz devam eder */
    }
  }
  if (ctx && ctx.state === 'suspended') ctx.resume();
}

function tone(freq, dur, { type = 'sine', vol = 0.2, slide = 0, delay = 0 } = {}) {
  if (!ctx || ctx.state !== 'running') return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
  gain.gain.setValueAtTime(vol, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

export const sfx = {
  jump()    { tone(240, 0.16, { type: 'square', vol: 0.06, slide: 260 }); },
  hit()     { tone(170, 0.1,  { type: 'triangle', vol: 0.28, slide: 140 });
              tone(620, 0.05, { vol: 0.07 }); },
  bounce()  { tone(115, 0.13, { type: 'sine', vol: 0.2, slide: -45 }); },
  net()     { tone(210, 0.08, { type: 'sine', vol: 0.09 }); },
  boing()   { tone(310, 0.3,  { type: 'square', vol: 0.055, slide: -230 }); },
  racket()  { tone(120, 0.14, { type: 'square', vol: 0.24, slide: -55 });
              tone(720, 0.06, { type: 'triangle', vol: 0.1 }); },
  wall()    { tone(150, 0.08, { type: 'sine', vol: 0.08 }); },
  whistle() { tone(1420, 0.16, { type: 'square', vol: 0.05 });
              tone(1420, 0.28, { type: 'square', vol: 0.05, delay: 0.2 }); },
  score()   { tone(523, 0.12, { type: 'triangle', vol: 0.14 });
              tone(659, 0.12, { type: 'triangle', vol: 0.14, delay: 0.12 });
              tone(784, 0.2,  { type: 'triangle', vol: 0.14, delay: 0.24 }); },
  concede() { tone(320, 0.3,  { type: 'sawtooth', vol: 0.06, slide: -170 }); },
  win()     { [523, 659, 784, 1047].forEach((f, i) =>
                tone(f, 0.2, { type: 'triangle', vol: 0.13, delay: i * 0.15 })); },
  lose()    { [392, 330, 262].forEach((f, i) =>
                tone(f, 0.25, { type: 'triangle', vol: 0.1, delay: i * 0.2 })); },
};
