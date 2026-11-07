// Motor de leitura. Com áudio ligado, a VOZ comanda a tela: cada evento
// `boundary` do SpeechSynthesis mostra a palavra que está sendo falada.
// Se a voz não emite esses eventos, um temporizador estima o tempo de cada
// palavra e se ressincroniza no fim de cada frase. Sem áudio, o temporizador
// segue o WPM escolhido.

import { wordWeight } from './text.js';

const DEFAULT_CALIBRATION = 180; // wpm de uma voz inglesa típica em rate = 1
const START_TIMEOUT_MS = 4000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const hasSpeech = () => 'speechSynthesis' in window;

/** Vozes em inglês do aparelho: en-US primeiro, depois as que funcionam offline. */
export function englishVoices() {
  if (!hasSpeech()) return [];
  return speechSynthesis
    .getVoices()
    .filter((v) => /^en([-_]|$)/i.test(v.lang))
    .sort((a, b) =>
      (b.lang.replace('_', '-') === 'en-US') - (a.lang.replace('_', '-') === 'en-US')
      || b.localService - a.localService
      || a.name.localeCompare(b.name));
}

export class Reader {
  constructor({ onWord, onState, onStats }) {
    this.onWord = onWord;
    this.onState = onState;
    this.onStats = onStats;
    this.doc = null;
    this.index = 0;
    this.playing = false;
    this.wpm = 220;
    this.audio = true;
    this.voice = null;
    this.calibration = DEFAULT_CALIBRATION;
    this.boundaryWorks = false;
    this.gen = 0; // geração: invalida eventos de falas já canceladas
    this.timer = null;
    this.watchdog = null;
    this.utterance = null; // referência viva: o Chrome perde o onend se a fala for coletada
  }

  load(doc, index = 0) {
    this.pause();
    this.doc = doc;
    this.index = clamp(index, 0, Math.max(0, doc.words.length - 1));
    this.onWord(this.index);
  }

  get chunkIndex() {
    return this.doc?.words[this.index]?.chunk ?? 0;
  }

  /** wpm real esperado da voz com o rate atual */
  get effectiveWpm() {
    if (!this.audio || !hasSpeech()) return this.wpm;
    return Math.round(this.calibration * this.rate);
  }

  get rate() {
    return clamp(this.wpm / this.calibration, 0.5, 3);
  }

  play() {
    if (!this.doc?.words.length || this.playing) return;
    if (this.index >= this.doc.words.length - 1) this.index = 0;
    this.playing = true;
    this.onState('playing');
    this._run();
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
    if (!this.doc) return;
    this.index = clamp(i, 0, this.doc.words.length - 1);
    this.onWord(this.index);
    if (this.playing) {
      this._halt();
      this._run();
    }
  }

  nextChunk() {
    const { chunks } = this.doc;
    const c = this.chunkIndex;
    if (c + 1 < chunks.length) this.seek(chunks[c + 1].start);
  }

  /** Volta ao início da frase atual; se já estiver no começo, vai para a anterior. */
  prevChunk() {
    const { chunks } = this.doc;
    const c = this.chunkIndex;
    const atStart = this.index - chunks[c].start <= 2;
    this.seek(atStart && c > 0 ? chunks[c - 1].start : chunks[c].start);
  }

  setWpm(wpm) {
    this.wpm = clamp(Math.round(wpm), 80, 900);
    this.onStats?.();
  }

  setAudio(on) {
    this.audio = on;
    this._restartIfPlaying();
  }

  setVoice(voice) {
    const same = voice?.voiceURI === this.voice?.voiceURI;
    this.voice = voice;
    if (same) return; // getVoices() pode recriar os objetos da mesma voz
    this.calibration = DEFAULT_CALIBRATION;
    this.boundaryWorks = false;
    this._restartIfPlaying();
  }

  _restartIfPlaying() {
    if (!this.playing) return;
    this._halt();
    this._run();
  }

  _halt() {
    this.gen++;
    clearTimeout(this.timer);
    clearTimeout(this.watchdog);
    this.timer = this.watchdog = null;
    if (hasSpeech() && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
    this.utterance = null;
  }

  _run() {
    const gen = ++this.gen;
    if (this.audio && hasSpeech()) {
      // pequeno atraso: no Android, falar logo após cancel() às vezes descarta a fala
      this.timer = setTimeout(() => this._speakFrom(this.index, gen), 60);
    } else {
      this._tick(gen);
    }
  }

  _finish() {
    this.playing = false;
    this._halt();
    this.onState('ended');
  }

  // ---- modo silencioso: temporizador pelo WPM ----
  _tick(gen) {
    if (gen !== this.gen || !this.playing) return;
    const { words, chunks, avgWeight } = this.doc;
    const word = words[this.index];
    this.onWord(this.index);
    const chunk = chunks[word.chunk];
    let ms = (60000 / this.wpm) * wordWeight(word.text) / avgWeight;
    if (this.index === chunk.end - 1 && chunk.paraEnd) ms += 60000 / this.wpm;
    this.timer = setTimeout(() => {
      if (gen !== this.gen) return;
      if (this.index + 1 >= words.length) return this._finish();
      this.index++;
      this._tick(gen);
    }, ms);
  }

  // ---- modo voz: a fala comanda a palavra exibida ----
  _speakFrom(startIdx, gen) {
    if (gen !== this.gen || !this.playing) return;
    const { words, chunks } = this.doc;
    const chunk = chunks[words[startIdx].chunk];
    const slice = words.slice(startIdx, chunk.end);

    // texto da fala + posição (charIndex) onde cada palavra começa
    const offsets = [];
    let text = '';
    for (const w of slice) {
      offsets.push(text.length);
      text += w.text + ' ';
    }

    const rate = this.rate;
    const u = new SpeechSynthesisUtterance(text.trimEnd());
    u.lang = this.voice?.lang || 'en-US';
    if (this.voice) u.voice = this.voice;
    u.rate = rate;

    let shown = 0;
    let startedAt = 0;
    const show = (k) => {
      if (gen !== this.gen) return;
      shown = clamp(k, shown, slice.length - 1); // nunca anda para trás dentro da frase
      this.index = startIdx + shown;
      this.onWord(this.index);
    };

    u.onstart = () => {
      if (gen !== this.gen) return;
      clearTimeout(this.watchdog);
      startedAt = performance.now();
      show(0);
      if (!this.boundaryWorks) this._estimate(gen, slice, rate, show);
    };

    u.onboundary = (e) => {
      if (gen !== this.gen || (e.name && e.name !== 'word')) return;
      if (!this.boundaryWorks) {
        this.boundaryWorks = true;
        clearTimeout(this.timer);
        this.onStats?.();
      }
      show(findWord(offsets, e.charIndex));
    };

    u.onend = () => {
      if (gen !== this.gen) return;
      clearTimeout(this.timer);
      const elapsed = performance.now() - startedAt;
      if (startedAt && startIdx === chunk.start && slice.length >= 5) {
        this._calibrate(slice.length, elapsed, rate);
      }
      show(slice.length - 1);
      if (chunk.end >= words.length) return this._finish();
      this.index = chunk.end;
      const next = () => this._speakFrom(chunk.end, gen);
      this.timer = setTimeout(next, chunk.paraEnd ? 350 : 0);
    };

    u.onerror = (e) => {
      if (gen !== this.gen || e.error === 'interrupted' || e.error === 'canceled') return;
      console.warn('[TTS] erro:', e.error);
      this._fallbackToSilent(gen, e.error);
    };

    // se a voz nunca começar (motor travado / sem voz), segue sem áudio
    this.watchdog = setTimeout(() => {
      if (gen === this.gen && !startedAt) this._fallbackToSilent(gen, 'timeout');
    }, START_TIMEOUT_MS);

    this.utterance = u;
    speechSynthesis.speak(u);
  }

  _fallbackToSilent(gen, reason) {
    clearTimeout(this.watchdog);
    if (hasSpeech()) speechSynthesis.cancel();
    this.audio = false;
    this.onStats?.({ audioError: reason });
    this._tick(gen);
  }

  /** Avança as palavras por estimativa quando a voz não informa os limites. */
  _estimate(gen, slice, rate, show) {
    const total = slice.reduce((s, w) => s + wordWeight(w.text), 0);
    const expectedMs = (slice.length / (this.calibration * rate)) * 60000;
    let k = 0;
    const step = () => {
      if (gen !== this.gen || this.boundaryWorks || k >= slice.length - 1) return;
      const ms = (expectedMs * wordWeight(slice[k].text)) / total;
      this.timer = setTimeout(() => {
        k++;
        show(k);
        step();
      }, ms);
    };
    step();
  }

  /** Mede a velocidade real da voz e ajusta o rate para bater com o WPM pedido. */
  _calibrate(nWords, ms, rate) {
    const measured = nWords / (ms / 60000) / rate;
    if (measured < 60 || measured > 400) return;
    this.calibration = this.calibration * 0.7 + measured * 0.3;
    this.onStats?.();
  }
}

function findWord(offsets, charIndex) {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= charIndex) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
