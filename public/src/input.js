// Klavye durumu — WASD + Space (+ ok tuşları alternatif)
export class Input {
  constructor() {
    this.keys = new Set();
    this._down = (e) => {
      // Menü butonu / kod girişi odaktayken oyuna karışma
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'BUTTON' || t.tagName === 'TEXTAREA')) return;
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      this.keys.add(e.code);
    };
    this._up = (e) => this.keys.delete(e.code);
    this._blur = () => this.keys.clear();
    window.addEventListener('keydown', this._down);
    window.addEventListener('keyup', this._up);
    window.addEventListener('blur', this._blur);
  }

  // Ham tuş durumu — dünya yönüne çevirme işi kamerada (GTA tarzı: W = kameranın baktığı yön)
  raw() {
    const k = this.keys;
    return {
      f: (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0),
      r: (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0),
      jump: k.has('Space'),
    };
  }

  dispose() {
    window.removeEventListener('keydown', this._down);
    window.removeEventListener('keyup', this._up);
    window.removeEventListener('blur', this._blur);
  }
}
