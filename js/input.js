// Controles com o celular dentro do VR Box: controle Bluetooth (teclado,
// mídia ou gamepad), toque/clique e gestos de cabeça (acelerômetro).

const KEYMAP = {
  ' ': 'toggle', Enter: 'toggle', k: 'toggle', MediaPlayPause: 'toggle', MediaPlay: 'toggle', MediaPause: 'toggle',
  ArrowRight: 'next', l: 'next', PageDown: 'next', MediaTrackNext: 'next', MediaFastForward: 'next',
  ArrowLeft: 'prev', j: 'prev', PageUp: 'prev', MediaTrackPrevious: 'prev', MediaRewind: 'prev',
  ArrowUp: 'faster', '+': 'faster', '=': 'faster',
  ArrowDown: 'slower', '-': 'slower',
  Escape: 'exit', Backspace: 'exit', q: 'exit',
};

// Gamepad padrão: A/B/X/Y = 0..3, LB/RB = 4/5, Select/Start = 8/9, D-pad = 12..15
const PAD_BUTTONS = { 0: 'toggle', 9: 'toggle', 1: 'prev', 2: 'prev', 3: 'next', 4: 'slower', 5: 'faster', 8: 'exit', 12: 'faster', 13: 'slower', 14: 'prev', 15: 'next' };

const LONG_PRESS_MS = 800;

export class Controls {
  /** @param {Record<string, () => void>} actions toggle, next, prev, faster, slower, exit */
  constructor(surface, actions) {
    this.surface = surface;
    this.actions = actions;
    this.active = false;
    this.padState = new Map();
    this.padFrame = null;

    window.addEventListener('keydown', (e) => {
      if (!this.active) return;
      const action = KEYMAP[e.key] ?? KEYMAP[e.key.toLowerCase()];
      if (!action) return;
      e.preventDefault();
      if (!e.repeat || action === 'faster' || action === 'slower') this.fire(action);
    });

    // toque curto = play/pause; toque longo = sair
    let pressTimer = null;
    let longFired = false;
    surface.addEventListener('pointerdown', () => {
      longFired = false;
      pressTimer = setTimeout(() => {
        longFired = true;
        this.fire('exit');
      }, LONG_PRESS_MS);
    });
    surface.addEventListener('pointerup', () => {
      clearTimeout(pressTimer);
      if (!longFired && this.active) this.fire('toggle');
    });
    surface.addEventListener('pointercancel', () => clearTimeout(pressTimer));
    surface.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('gamepadconnected', () => this._pollPads());
  }

  fire(action) {
    this.actions[action]?.();
  }

  start() {
    this.active = true;
    this._pollPads();
  }

  stop() {
    this.active = false;
    cancelAnimationFrame(this.padFrame);
    this.padFrame = null;
  }

  _pollPads() {
    if (!this.active || this.padFrame || !navigator.getGamepads) return;
    const loop = () => {
      if (!this.active) return;
      for (const pad of navigator.getGamepads()) {
        if (pad) this._readPad(pad);
      }
      this.padFrame = requestAnimationFrame(loop);
    };
    this.padFrame = requestAnimationFrame(loop);
  }

  _readPad(pad) {
    const pressed = new Set();
    pad.buttons.forEach((b, i) => {
      if (b.pressed && PAD_BUTTONS[i]) pressed.add(PAD_BUTTONS[i]);
    });
    const [x = 0, y = 0] = pad.axes;
    if (x < -0.7) pressed.add('prev');
    if (x > 0.7) pressed.add('next');
    if (y < -0.7) pressed.add('faster');
    if (y > 0.7) pressed.add('slower');

    // dispara só na borda (soltou -> apertou)
    const before = this.padState.get(pad.index) ?? new Set();
    for (const action of pressed) if (!before.has(action)) this.fire(action);
    this.padState.set(pad.index, pressed);
  }
}

/**
 * Gestos de cabeça pelo vetor da gravidade:
 *  - inclinar a cabeça para a direita/esquerda (orelha no ombro) = próxima/anterior frase
 *  - abaixar a cabeça (olhar para baixo) = play/pause
 * O ângulo "neutro" é capturado ao entrar no VR e acompanha devagar a postura.
 */
export class HeadGestures {
  constructor(onGesture, { rollDeg = 22, nodDeg = 25, holdMs = 250 } = {}) {
    this.onGesture = onGesture;
    this.rollDeg = rollDeg;
    this.nodDeg = nodDeg;
    this.holdMs = holdMs;
    this.invert = false;
    this.running = false;
    this._onMotion = this._onMotion.bind(this);
  }

  /** Precisa ser chamado dentro de um clique (exigência do iOS). */
  static async requestPermission() {
    const DME = window.DeviceMotionEvent;
    if (!DME) return false;
    if (typeof DME.requestPermission === 'function') {
      try {
        return (await DME.requestPermission()) === 'granted';
      } catch {
        return false;
      }
    }
    return true;
  }

  start(calibrateAfterMs = 0) {
    this.g = null;
    this.neutral = null;
    this.armed = false;
    this.pending = null;
    this.calibrateAt = performance.now() + calibrateAfterMs;
    if (!this.running) window.addEventListener('devicemotion', this._onMotion);
    this.running = true;
  }

  stop() {
    window.removeEventListener('devicemotion', this._onMotion);
    this.running = false;
  }

  recenter() {
    this.neutral = null;
  }

  _onMotion(e) {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null) return;

    // filtro passa-baixa: fica só a gravidade
    if (!this.g) this.g = { x: a.x, y: a.y, z: a.z };
    const k = 0.15;
    this.g.x += (a.x - this.g.x) * k;
    this.g.y += (a.y - this.g.y) * k;
    this.g.z += (a.z - this.g.z) * k;
    const { x, y, z } = this.g;
    const n = Math.hypot(x, y, z) || 1;
    const roll = (Math.atan2(x, y) * 180) / Math.PI; // giro em torno do eixo da tela
    const tilt = (Math.asin(Math.max(-1, Math.min(1, z / n))) * 180) / Math.PI; // inclinação da tela
    const now = performance.now();

    if (!this.neutral) {
      if (now >= this.calibrateAt) this.neutral = { roll, tilt };
      return;
    }

    const dRoll = wrapDeg(roll - this.neutral.roll) * (this.invert ? -1 : 1);
    const dTilt = tilt - this.neutral.tilt;

    // volta ao neutro antes de aceitar outro gesto
    if (Math.abs(dRoll) < 8 && Math.abs(dTilt) < 10) {
      this.armed = true;
      this.pending = null;
      // acompanha lentamente mudanças de postura
      this.neutral.roll += wrapDeg(roll - this.neutral.roll) * 0.01;
      this.neutral.tilt += (tilt - this.neutral.tilt) * 0.01;
      return;
    }
    if (!this.armed) return;

    let gesture = null;
    // inclinar para a direita gira o aparelho no sentido horário => roll diminui
    if (dRoll < -this.rollDeg) gesture = 'next';
    else if (dRoll > this.rollDeg) gesture = 'prev';
    else if (Math.abs(dTilt) > this.nodDeg) gesture = 'toggle';

    if (!gesture) {
      this.pending = null;
      return;
    }
    if (this.pending?.gesture !== gesture) {
      this.pending = { gesture, since: now };
    } else if (now - this.pending.since >= this.holdMs) {
      this.armed = false;
      this.pending = null;
      this.onGesture(gesture);
    }
  }
}

function wrapDeg(d) {
  return ((((d + 180) % 360) + 360) % 360) - 180;
}
