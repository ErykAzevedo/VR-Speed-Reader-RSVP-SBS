// Pareamento painel ↔ celular por WebRTC (PeerJS, carregado em window.Peer).
// O painel registra o id "vrsr-<código>" no servidor público do PeerJS e o
// celular conecta nesse id. O servidor só apresenta os dois aparelhos: depois
// disso as mensagens vão direto de um para o outro, criptografadas.

const PREFIX = 'vrsr-';
const RETRY_MS = 3000;
const DIAL_TIMEOUT_MS = 10000;
const NETWORK_ERRORS = ['network', 'server-error', 'socket-error', 'socket-closed'];

export const newCode = () => String(Math.floor(100000 + Math.random() * 900000));
const hasPeer = () => typeof window.Peer === 'function';

class Link {
  constructor({ onState, onMessage }) {
    this.onState = onState;
    this.onMessage = onMessage;
    this.state = 'idle';
    this.retry = null;
  }

  later(fn, ms = RETRY_MS) {
    clearTimeout(this.retry);
    this.retry = setTimeout(fn, ms);
  }

  setState(state) {
    if (state === this.state) return;
    this.state = state;
    this.onState?.(state);
  }
}

/**
 * Lado do painel: registra o código e espera o celular.
 * Estados: unavailable · starting · waiting · connected · offline · taken
 */
export class PanelLink extends Link {
  constructor({ onState, onMessage, onConnect }) {
    super({ onState, onMessage });
    this.onConnect = onConnect;
    this.conns = new Set();
    this.peer = null;
    this.attempts = 0;
  }

  get connected() {
    return [...this.conns].some((c) => c.open);
  }

  start(code) {
    this.stop();
    this.code = code;
    if (!hasPeer()) return this.setState('unavailable');
    this.setState('starting');
    const peer = new window.Peer(PREFIX + code, { debug: 1 });
    this.peer = peer;

    peer.on('open', () => {
      this.attempts = 0;
      this.setState(this.connected ? 'connected' : 'waiting');
    });
    peer.on('connection', (conn) => {
      conn.on('open', () => {
        this.conns.add(conn);
        this.setState('connected');
        this.onConnect?.(conn);
      });
      conn.on('data', (msg) => this.onMessage?.(msg, conn));
      const drop = () => {
        this.conns.delete(conn);
        if (this.peer === peer) this.setState(this.connected ? 'connected' : 'waiting');
      };
      conn.on('close', drop);
      conn.on('error', drop);
    });
    peer.on('disconnected', () => {
      // perdeu o servidor de pareamento (as conexões já abertas continuam)
      if (this.peer === peer && !peer.destroyed) this.later(() => peer.reconnect());
    });
    peer.on('error', (err) => {
      if (this.peer !== peer) return;
      if (err.type === 'unavailable-id') {
        // o servidor ainda guarda o código da sessão anterior desta aba: espera liberar
        peer.destroy();
        if (++this.attempts > 8) return this.setState('taken');
        this.setState('starting');
        this.later(() => this.start(code), 4000);
      } else if (NETWORK_ERRORS.includes(err.type)) {
        peer.destroy();
        this.setState('offline');
        this.later(() => this.start(code), 5000);
      }
    });
  }

  stop() {
    clearTimeout(this.retry);
    for (const conn of this.conns) conn.close();
    this.conns.clear();
    const peer = this.peer;
    this.peer = null;
    peer?.destroy();
  }

  send(msg) {
    for (const conn of this.conns) if (conn.open) conn.send(msg);
  }
}

/**
 * Lado do celular: conecta no código do painel e reconecta sozinho.
 * Estados: unavailable · no-code · searching · connected · offline
 */
export class PhoneLink extends Link {
  constructor({ onState, onMessage, onOpen }) {
    super({ onState, onMessage });
    this.onOpen = onOpen;
    this.peer = null;
    this.conn = null;
    this.code = '';
    this.dialTimer = null;
  }

  get connected() {
    return !!this.conn?.open;
  }

  connect(code) {
    this.code = code;
    clearTimeout(this.retry);
    if (!hasPeer()) return this.setState('unavailable');
    if (!code) return this.setState('no-code');
    if (this.peer && !this.peer.destroyed) {
      if (this.peer.open) this.dial();
      return;
    }
    const peer = new window.Peer({ debug: 1 });
    this.peer = peer;
    this.setState('searching');
    peer.on('open', () => this.dial());
    peer.on('disconnected', () => {
      if (this.peer === peer && !peer.destroyed) this.later(() => peer.reconnect());
    });
    peer.on('error', (err) => {
      if (this.peer !== peer) return;
      if (err.type === 'peer-unavailable') {
        this.setState('searching'); // painel fechado ou código errado
      } else if (NETWORK_ERRORS.includes(err.type)) {
        peer.destroy();
        this.setState('offline');
      }
      this.later(() => this.connect(this.code));
    });
  }

  dial() {
    clearTimeout(this.dialTimer);
    this.conn?.close();
    const conn = this.peer.connect(PREFIX + this.code, { reliable: true });
    this.conn = conn;
    this.setState('searching');
    // sem resposta (rede bloqueando WebRTC): tenta de novo
    this.dialTimer = setTimeout(() => {
      if (this.conn === conn && !conn.open) this.dial();
    }, DIAL_TIMEOUT_MS);
    conn.on('open', () => {
      if (this.conn !== conn) return;
      clearTimeout(this.dialTimer);
      this.setState('connected');
      this.onOpen?.();
    });
    conn.on('data', (msg) => this.onMessage?.(msg));
    conn.on('close', () => {
      if (this.conn !== conn) return;
      this.conn = null;
      this.setState('searching');
      this.later(() => this.connect(this.code));
    });
  }

  send(msg) {
    if (this.conn?.open) this.conn.send(msg);
  }
}
