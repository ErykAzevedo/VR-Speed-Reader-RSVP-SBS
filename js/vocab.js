// Vocabulário: lista de palavras com imagem, cache das imagens e o player
// que repete a lista N vezes falando cada palavra.

import { hasSpeech } from './reader.js';

const URL_RE = /^https?:\/\/\S+$/i;
const CACHE_NAME = 'vrsr-images-v1';
const LOAD_TIMEOUT_MS = 20000;

const unquote = (s) => s.trim().replace(/^["']|["']$/g, '').trim();

export const formatPace = (p) => `${String(p).replace('.', ',')} s`;

/** Itens que entram na sessão: no modo imagem, só os que têm link que não falhou. */
export function sessionItems(items, mode, images) {
  return mode === 'image'
    ? items.filter((i) => i.url && images.state(i.url) !== 'error')
    : items.slice();
}

/**
 * Uma palavra por linha: "palavra, link" (também aceita ; ou tab, e linha só com a palavra).
 * Linhas cujo segundo campo não é um link (ex.: cabeçalho do CSV) são ignoradas.
 */
export function parseVocabLines(text) {
  const items = [];
  let skipped = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const sep = line.search(/[,;\t]/);
    const word = unquote(sep < 0 ? line : line.slice(0, sep));
    const url = sep < 0 ? '' : unquote(line.slice(sep + 1));
    if (!word || (url && !URL_RE.test(url))) {
      skipped++;
      continue;
    }
    items.push({ word, url });
  }
  return { items, skipped };
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

async function openCache() {
  try {
    return 'caches' in window ? await caches.open(CACHE_NAME) : null;
  } catch {
    return null; // sem HTTPS não há Cache Storage
  }
}

/**
 * Pré-carrega as imagens antes de entrar no VR.
 * 1. Se o servidor da imagem permite (CORS), guarda no Cache Storage: fica salva
 *    entre sessões e funciona offline.
 * 2. Senão, carrega direto: fica no cache do navegador e decodificada na memória
 *    enquanto o app está aberto.
 * Em ambos os casos a imagem já está decodificada quando a palavra é falada.
 */
export class ImageStore {
  constructor(onChange) {
    this.onChange = onChange;
    this.entries = new Map(); // url -> { state, src, img, promise }
  }

  state(url) {
    return this.entries.get(url)?.state ?? 'none';
  }

  src(url) {
    return this.entries.get(url)?.src;
  }

  load(url) {
    if (!url) return Promise.resolve(null);
    const existing = this.entries.get(url);
    if (existing) return existing.promise;
    const entry = { state: 'loading', src: null, img: null };
    entry.promise = this._load(url).then(
      ({ src, img }) => {
        Object.assign(entry, { state: 'ok', src, img });
        this.onChange?.(url);
        return entry;
      },
      (err) => {
        Object.assign(entry, { state: 'error', error: String(err?.message || err) });
        this.onChange?.(url);
        return entry;
      },
    );
    this.entries.set(url, entry);
    this.onChange?.(url);
    return entry.promise;
  }

  retry(url) {
    if (this.state(url) === 'error') this.entries.delete(url);
    return this.load(url);
  }

  /** Espera as imagens terminarem (ou falharem), no máximo `timeoutMs`. */
  whenSettled(urls, timeoutMs = LOAD_TIMEOUT_MS) {
    const all = Promise.all(urls.map((u) => this.load(u)));
    return withTimeout(all, timeoutMs).catch(() => {});
  }

  async forget(url) {
    const entry = this.entries.get(url);
    if (entry?.src?.startsWith('blob:')) URL.revokeObjectURL(entry.src);
    this.entries.delete(url);
    (await openCache())?.delete(url);
  }

  async _load(url) {
    const cache = await openCache();
    let src = null;
    if (cache) {
      try {
        let res = await cache.match(url);
        if (!res) {
          const fetched = await withTimeout(fetch(url, { mode: 'cors' }), LOAD_TIMEOUT_MS);
          if (fetched.ok && (fetched.headers.get('content-type') || '').startsWith('image/')) {
            await cache.put(url, fetched.clone());
            res = fetched;
          }
        }
        if (res) src = URL.createObjectURL(await res.blob());
      } catch {
        // servidor sem CORS: segue para o carregamento direto
      }
    }

    const img = new Image();
    try {
      // "load" chega mesmo com a página em segundo plano; decode() só depois de desenhar
      await withTimeout(new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('imagem não carregou'));
        img.src = src || url;
      }), LOAD_TIMEOUT_MS);
      img.decode?.().catch(() => {}); // já deixa decodificada para aparecer sem atraso no VR
    } catch (err) {
      if (src) {
        URL.revokeObjectURL(src);
        cache?.delete(url); // cópia salva corrompida: não reaproveitar
      }
      throw err;
    }
    return { src: img.src, img };
  }
}

function shuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Toca a lista `reps` vezes. Cada item fica na tela por `pace` segundos ou até a
 * voz terminar de falar a palavra, o que for mais longo.
 */
export class VocabPlayer {
  constructor({ onItem, onState }) {
    this.onItem = onItem;
    this.onState = onState;
    this.seq = [];
    this.index = 0;
    this.reps = 1;
    this.count = 0;
    this.playing = false;
    this.ended = false;
    this.pace = 2;
    this.audio = true;
    this.voice = null;
    this.gen = 0;
    this.timer = null;
    this.watchdog = null;
    this.utterance = null;
  }

  setup(items, { reps, shuffle }) {
    this.pause();
    this.seq = [];
    this.reps = reps;
    this.count = items.length;
    let lastOfRound = null;
    for (let round = 0; round < reps; round++) {
      const order = shuffle ? shuffled(items) : items.slice();
      // evita a mesma palavra duas vezes seguidas na virada da volta
      if (order.length > 1 && order[0] === lastOfRound) [order[0], order[1]] = [order[1], order[0]];
      order.forEach((item, pos) => this.seq.push({ item, round, pos }));
      lastOfRound = order[order.length - 1];
    }
    this.index = 0;
    this.ended = false;
  }

  get current() {
    return this.seq[this.index];
  }

  setPace(seconds) {
    this.pace = Math.min(10, Math.max(0.5, seconds));
  }

  play() {
    if (!this.seq.length || this.playing) return;
    if (this.ended) this.index = 0;
    this.ended = false;
    this.playing = true;
    this.onState('playing');
    this._show();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this._halt();
    this.onState('paused');
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  seek(i) {
    this.index = Math.min(this.seq.length - 1, Math.max(0, i));
    this.ended = false;
    if (this.playing) {
      this._halt();
      this._show();
    } else {
      this.onItem(this.current);
    }
  }

  next() {
    if (this.index < this.seq.length - 1) this.seek(this.index + 1);
  }

  prev() {
    if (this.index > 0) this.seek(this.index - 1);
  }

  _halt() {
    this.gen++;
    clearTimeout(this.timer);
    clearTimeout(this.watchdog);
    if (hasSpeech() && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
    this.utterance = null;
  }

  _finish() {
    this.playing = false;
    this.ended = true;
    this._halt();
    this.onState('ended');
  }

  _show() {
    const gen = ++this.gen;
    const step = this.current;
    this.onItem(step);

    let timeUp = false;
    let spoken = !this.audio || !hasSpeech();
    const advance = () => {
      if (gen !== this.gen || !timeUp || !spoken) return;
      if (this.index + 1 >= this.seq.length) return this._finish();
      this.index++;
      this._show();
    };
    this.timer = setTimeout(() => {
      timeUp = true;
      advance();
    }, this.pace * 1000);

    if (spoken) return;
    const done = () => {
      if (gen !== this.gen) return;
      clearTimeout(this.watchdog);
      spoken = true;
      advance();
    };
    const u = new SpeechSynthesisUtterance(step.item.word);
    u.lang = this.voice?.lang || 'en-US';
    if (this.voice) u.voice = this.voice;
    u.rate = 0.9;
    u.onend = done;
    u.onerror = (e) => {
      if (e.error !== 'interrupted' && e.error !== 'canceled') done();
    };
    // se a voz travar, segue a lista mesmo assim
    this.watchdog = setTimeout(done, this.pace * 1000 + 4000);
    this.utterance = u; // referência viva: o Chrome perde o onend se a fala for coletada
    // pequeno atraso: no Android, falar logo após cancel() às vezes descarta a fala
    setTimeout(() => gen === this.gen && speechSynthesis.speak(u), 40);
  }
}
