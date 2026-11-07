// Motor do modo VR: leitor de texto e sessões de vocabulário desenhados lado a
// lado. Usado pelo painel (tudo num aparelho só) e pela página do celular,
// que recebe as configurações e os comandos do painel.

import { parseText, textHash, buildGroups } from './text.js';
import { Reader, hasSpeech, englishVoices } from './reader.js';
import { SbsView } from './sbs.js';
import { Controls, HeadGestures } from './input.js';
import { VocabPlayer, formatPace } from './vocab.js';

export class VrEngine {
  /**
   * @param {object} o
   * @param {HTMLElement} o.root            o elemento #vr
   * @param {object} o.settings             configurações (o mesmo objeto de quem chama)
   * @param {object} o.store
   * @param {import('./vocab.js').ImageStore} o.images
   * @param {'leave'|'idle'} [o.exitMode]   "sair" no VR fecha o VR, ou só para e volta à espera
   * @param {(patch: object, note?: string) => void} [o.onSettingsChange]  o VR mudou uma configuração
   * @param {(status: object) => void} [o.onStatus]
   * @param {() => void} [o.onExit]         o VR foi fechado
   */
  constructor({ root, settings, store, images, exitMode = 'leave', onSettingsChange, onStatus, onExit }) {
    Object.assign(this, { root, settings, store, images, exitMode, onSettingsChange, onStatus, onExit });
    this.view = new SbsView(root);
    this.doc = null;
    this.docHash = '';
    this.lastSaved = 0;
    this.inVr = false;
    this.session = null; // 'text' | 'vocab' | null (esperando)
    this.vocabInfo = null; // { mode, reps, count } da sessão de vocabulário
    this.preparing = ''; // status enquanto as imagens terminam de carregar
    this.label = ''; // linha de status atual
    this.idle = { message: 'Pronto', status: '' };
    this.wentFullscreen = false;
    this.wakeLock = null;
    this.headAllowed = false;
    this.countdownLeft = 0;
    this.countdownTimer = null;

    this.reader = new Reader({
      onWord: (i) => {
        if (this.showing('text')) this.renderWord(i);
        if (Date.now() - this.lastSaved > 5000) this.savePosition();
      },
      onState: (state) => {
        if (state !== 'playing') this.savePosition();
        if (!this.showing('text')) return;
        this.view.setPaused(state !== 'playing');
        if (state !== 'playing') this.renderWord(this.reader.index);
        if (state === 'ended') this.view.flash('✓ fim');
        this.renderStatus();
      },
      onStats: (info) => {
        if (info?.audioError) {
          this.settings.audio = false;
          this.onSettingsChange?.({ audio: false }, `A voz falhou (${info.audioError}); a leitura continuou sem áudio.`);
        }
        this.renderStatus();
      },
    });

    this.vocab = new VocabPlayer({
      onItem: (step) => {
        if (this.showing('vocab')) this.renderVocabItem(step);
      },
      onState: (state) => {
        if (!this.showing('vocab')) return;
        this.view.setPaused(state !== 'playing');
        if (state === 'ended') this.view.flash('✓ fim');
        this.renderStatus();
      },
    });

    this.actions = {
      toggle: () => {
        if (this.preparing) return;
        if (!this.session) {
          this.view.flash('aguardando o painel');
          return;
        }
        const player = this.player;
        if (this.countdownLeft > 0) {
          this.cancelCountdown();
          player.play();
        } else {
          player.toggle();
        }
        this.view.flash(player.playing ? '▶' : '⏸');
      },
      next: () => this.step(+1),
      prev: () => this.step(-1),
      faster: () => (this.session === 'vocab' ? this.changePace(-0.5) : this.changeWpm(+20)),
      slower: () => (this.session === 'vocab' ? this.changePace(+0.5) : this.changeWpm(-20)),
      exit: () => (this.exitMode === 'idle' ? this.stop() : this.exit()),
    };
    this.controls = new Controls(root, this.actions);
    this.head = new HeadGestures((gesture) => this.actions[gesture]());

    document.addEventListener('fullscreenchange', () => {
      // botão Voltar do Android sai da tela cheia: sai do VR junto
      if (!document.fullscreenElement && this.inVr && this.wentFullscreen) this.exit();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.reader.pause();
        this.vocab.pause();
        this.savePosition();
      } else if (this.inVr) {
        this.requestWakeLock();
      }
    });
    window.addEventListener('resize', () => this.rerender());
    if (hasSpeech()) speechSynthesis.addEventListener?.('voiceschanged', () => this.applyVoice());

    this.applySettings();
  }

  get player() {
    return this.session === 'vocab' ? this.vocab : this.reader;
  }

  showing(kind) {
    return this.inVr && this.session === kind;
  }

  // ---------------- conteúdo ----------------

  /** Carrega o texto; se for o mesmo de antes, mantém a posição de leitura. */
  setText(raw) {
    const hash = textHash(raw);
    if (this.doc && hash === this.docHash) return;
    this.doc = parseText(raw);
    this.docHash = hash;
    const saved = this.store.get('pos', null);
    this.reader.load(this.doc, saved?.hash === hash ? saved.index : 0);
    if (this.showing('text')) this.rerender();
  }

  get position() {
    return { index: this.reader.index, total: this.doc?.words.length ?? 0, hash: this.docHash };
  }

  restart() {
    if (!this.doc) return;
    this.reader.seek(0);
    this.savePosition();
  }

  savePosition() {
    if (!this.doc) return;
    this.store.set('pos', { hash: this.docHash, index: this.reader.index });
    this.lastSaved = Date.now();
  }

  // ---------------- configurações ----------------

  /** Aplica `settings` (alterado por quem chama) na leitura e, no VR, na tela na hora. */
  applySettings() {
    const s = this.settings;
    this.reader.setWpm(s.wpm);
    const audio = s.audio && hasSpeech();
    if (this.reader.audio !== audio) this.reader.setAudio(audio);
    this.vocab.audio = audio;
    this.vocab.setPace(s.vocabPace);
    this.applyVoice();
    this.head.invert = s.headInvert;
    if (!this.inVr) return;
    this.applyView();
    this.updateHead();
    this.rerender();
  }

  applyVoice() {
    const voices = englishVoices();
    const voice = voices.find((v) => v.voiceURI === this.settings.voiceURI)
      ?? voices.find((v) => v.default)
      ?? voices[0]
      ?? null;
    this.reader.setVoice(voice);
    this.vocab.voice = voice;
  }

  applyView() {
    const s = this.settings;
    this.view.apply({
      fontSize: s.font,
      shiftX: s.shiftX,
      shiftY: s.shiftY,
      mono: s.mode === 'mono',
      showContext: s.context,
    });
  }

  updateHead() {
    if (this.inVr && this.settings.head && this.headAllowed) {
      // o "neutro" da cabeça é medido depois que o celular já está no VR Box
      if (!this.head.running) this.head.start(Math.max(1500, this.settings.countdown * 1000));
    } else {
      this.head.stop();
    }
  }

  changeWpm(delta) {
    this.reader.setWpm(this.reader.wpm + delta);
    this.settings.wpm = this.reader.wpm;
    this.onSettingsChange?.({ wpm: this.settings.wpm });
    this.view.flash(`${this.settings.wpm} wpm`);
    this.renderStatus();
  }

  changePace(delta) {
    const pace = Math.min(10, Math.max(1, Math.round((this.settings.vocabPace + delta) * 2) / 2));
    this.settings.vocabPace = pace;
    this.vocab.setPace(pace);
    this.onSettingsChange?.({ vocabPace: pace });
    this.view.flash(`${formatPace(pace)} por palavra`);
    this.renderStatus();
  }

  // ---------------- entrar e sair do VR ----------------

  /** Precisa rodar dentro de um toque/clique: libera a voz, a tela cheia e os sensores. */
  unlock({ motion = this.settings.head } = {}) {
    if (hasSpeech()) {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    }
    const motionAllowed = motion ? HeadGestures.requestPermission() : Promise.resolve(false);
    const el = document.documentElement;
    const fullscreen = el.requestFullscreen
      ? el.requestFullscreen({ navigationUI: 'hide' }).then(() => true, () => false)
      : Promise.resolve(false);
    return Promise.all([fullscreen, motionAllowed]).then(([fs, ok]) => {
      this.wentFullscreen = fs;
      this.headAllowed ||= ok;
      if (fs) screen.orientation?.lock?.('landscape').catch(() => {});
      this.updateHead();
      if (this.inVr && this.settings.head && !this.headAllowed) this.view.flash('sem sensor');
    });
  }

  show() {
    if (this.inVr) return;
    this.inVr = true;
    document.activeElement?.blur(); // evita que Espaço/Enter "clique" de novo no botão
    this.root.hidden = false;
    this.applyView();
    this.view.setPaused(true);
    this.controls.start();
    this.requestWakeLock();
    this.updateHead();
    this.rerender();
  }

  /** Começa a leitura do texto ('text') ou uma sessão de vocabulário ('vocab', com os itens). */
  start(kind, items) {
    this.halt();
    this.session = kind;
    this.view.setPaused(true);
    if (kind === 'text') {
      this.view.setMode('text');
      this.regroup();
      this.view.invalidate();
      this.renderWord(this.reader.index);
      this.startCountdown(() => this.reader.play());
    } else {
      this.view.setMode(this.settings.vocabMode, { caption: this.settings.vocabCaption });
      this.view.showWord('');
      this.view.showImage('', '');
      this.startVocab(items);
    }
    // recalibra o "neutro" da cabeça para depois da contagem
    if (this.head.running) this.head.start(Math.max(1500, this.settings.countdown * 1000));
  }

  /** Para o que estiver tocando e volta à tela de espera (continua no VR). */
  stop() {
    this.halt();
    this.session = null;
    if (this.inVr) this.renderIdle();
  }

  exit() {
    if (!this.inVr) return;
    this.stop();
    this.inVr = false;
    this.controls.stop();
    this.head.stop();
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    try {
      screen.orientation?.unlock?.();
    } catch {
      /* sem suporte */
    }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.root.hidden = true;
    this.savePosition();
    this.onExit?.();
    this.emitStatus();
  }

  /** Mensagem da tela de espera (sem leitura em andamento). */
  setIdle(message, status = '') {
    this.idle = { message, status };
    if (this.inVr && !this.session) this.renderIdle();
  }

  halt() {
    this.cancelCountdown();
    this.reader.pause();
    this.vocab.pause();
    this.preparing = '';
    this.preparingToken = null;
  }

  step(dir) {
    if (this.preparing || !this.session) return;
    this.cancelCountdown();
    if (this.session === 'vocab') {
      if (dir > 0) this.vocab.next();
      else this.vocab.prev();
    } else if (dir > 0) {
      this.reader.nextChunk();
    } else {
      this.reader.prevChunk();
    }
    this.view.flash(dir > 0 ? '⏭' : '⏮');
    this.renderStatus();
  }

  async startVocab(items) {
    const mode = this.settings.vocabMode;
    if (mode === 'image') {
      // espera as imagens que ainda estão baixando; as que falharem ficam de fora
      const token = (this.preparingToken = Symbol('preparo'));
      const urls = items.map((i) => i.url);
      const update = () => {
        if (this.preparingToken !== token) return;
        const ready = urls.filter((u) => this.images.state(u) === 'ok').length;
        this.preparing = `Preparando imagens ${ready} de ${urls.length}…`;
        this.renderStatus();
      };
      update();
      const ticker = setInterval(update, 300);
      await this.images.whenSettled(urls);
      clearInterval(ticker);
      if (this.preparingToken !== token || !this.showing('vocab')) return; // parou ou saiu durante o preparo
      this.preparingToken = null;
      this.preparing = '';
      items = items.filter((i) => this.images.state(i.url) === 'ok');
      if (!items.length) {
        this.label = 'Nenhuma imagem carregou. Confira os links.';
        this.view.setStatus(this.label);
        this.emitStatus();
        return;
      }
    }
    this.vocabInfo = { mode, reps: this.settings.vocabReps, count: items.length };
    this.vocab.setup(items, { reps: this.settings.vocabReps, shuffle: this.settings.vocabShuffle });
    this.renderVocabItem(this.vocab.current);
    this.startCountdown(() => this.vocab.play());
  }

  startCountdown(onDone) {
    this.cancelCountdown();
    this.countdownLeft = this.settings.countdown;
    if (!this.countdownLeft) {
      onDone();
      return;
    }
    this.renderStatus();
    this.countdownTimer = setInterval(() => {
      this.countdownLeft--;
      this.renderStatus();
      if (this.countdownLeft <= 0) {
        this.cancelCountdown();
        onDone();
      }
    }, 1000);
  }

  cancelCountdown() {
    clearInterval(this.countdownTimer);
    this.countdownTimer = null;
    this.countdownLeft = 0;
  }

  async requestWakeLock() {
    try {
      this.wakeLock = await navigator.wakeLock?.request('screen');
    } catch {
      this.wakeLock = null;
    }
  }

  // ---------------- desenho ----------------

  /**
   * Monta os blocos de palavras para a largura real da lente: cabem ~N letras
   * no tamanho de fonte escolhido (refeito ao girar a tela ou mudar o tamanho).
   */
  regroup() {
    if (!this.doc) return;
    const eye = this.root.querySelector('.eye');
    const eyeWidth = eye?.clientWidth || Math.max(innerWidth, innerHeight) / (this.settings.mode === 'mono' ? 1 : 2);
    const maxChars = Math.max(8, Math.floor((eyeWidth * 0.9) / (this.settings.font * 0.55)));
    buildGroups(this.doc, this.settings.chunk, maxChars);
  }

  rerender() {
    if (!this.inVr) return;
    this.view.invalidate();
    if (this.session === 'text') {
      this.regroup();
      this.renderWord(this.reader.index);
      this.renderStatus();
    } else if (this.session === 'vocab') {
      this.view.setMode(this.vocabInfo?.mode ?? this.settings.vocabMode, { caption: this.settings.vocabCaption });
      this.renderVocabItem(this.vocab.current);
    } else {
      this.renderIdle();
    }
  }

  renderWord(i) {
    const { doc } = this;
    const w = doc?.words[i];
    if (!w) return;
    if (this.settings.chunk > 1 && doc.groups) {
      const g = doc.groups[w.group];
      const texts = doc.words.slice(g.start, g.end).map((x) => x.text);
      this.view.showChunk(texts, i - g.start, `${this.docHash}:${g.start}:${g.end}`);
    } else {
      this.view.showWord(w.text);
    }
    const chunk = doc.chunks[w.chunk];
    if (this.settings.context || !this.reader.playing) this.view.showContext(doc.words, chunk.start, chunk.end, i);
    this.view.setProgress(doc.words.length > 1 ? i / (doc.words.length - 1) : 1);
    this.emitStatus();
  }

  renderVocabItem(step) {
    if (!step || !this.vocabInfo) return;
    const { item, round, pos } = step;
    if (this.vocabInfo.mode === 'image') this.view.showImage(this.images.src(item.url), item.word);
    else this.view.showWord(item.word);
    this.view.setRounds(this.vocabInfo.reps, round, (pos + 1) / this.vocabInfo.count);
    this.renderStatus();
  }

  renderIdle() {
    this.view.setMode('text');
    this.view.setPaused(true);
    this.view.showChunk(this.idle.message.split(' '), -1, `idle:${this.idle.message}`);
    this.view.showContext([], 0, 0, -1);
    this.view.setProgress(0);
    this.label = this.idle.status;
    this.view.setStatus(this.label);
    this.emitStatus();
  }

  renderStatus() {
    if (this.session === 'vocab') this.renderVocabStatus();
    else if (this.session === 'text') this.renderTextStatus();
    this.emitStatus();
  }

  renderTextStatus() {
    const { doc, reader } = this;
    if (!doc) return;
    const pct = Math.round((reader.index / Math.max(1, doc.words.length - 1)) * 100);
    const atEnd = reader.index >= doc.words.length - 1;
    const state = this.countdownLeft > 0 ? `Começando em ${this.countdownLeft}…`
      : reader.playing ? '▶'
      : atEnd ? '✓ Fim' : '⏸ Pausado';
    const audio = reader.audio ? ' · 🔊' : '';
    this.label = `${state} · ${pct}% · ${reader.effectiveWpm} wpm${audio}`;
    this.view.setStatus(this.label);
  }

  renderVocabStatus() {
    if (this.preparing) {
      this.label = this.preparing;
      this.view.setStatus(this.label);
      return;
    }
    const step = this.vocab.current;
    if (!step || !this.vocabInfo) return;
    const noun = this.vocabInfo.mode === 'image' ? 'imagem' : 'palavra';
    const where = `Volta ${step.round + 1} de ${this.vocabInfo.reps} · ${noun} ${step.pos + 1} de ${this.vocabInfo.count}`;
    const state = this.countdownLeft > 0 ? `Começando em ${this.countdownLeft}…`
      : this.vocab.ended ? '✓ Fim'
      : this.vocab.playing ? '' : `⏸ Pausado · ${formatPace(this.vocab.pace)} por palavra`;
    this.label = state ? `${state} · ${where}` : where;
    this.view.setStatus(this.label);
  }

  /** Resumo do que está na tela, para o painel mostrar. */
  status() {
    const s = { inVr: this.inVr, session: this.session, state: 'idle', label: this.label, text: '', progress: 0 };
    if (!this.session) return s;
    const player = this.player;
    const ended = this.session === 'vocab'
      ? this.vocab.ended
      : !this.reader.playing && this.reader.index >= (this.doc?.words.length ?? 1) - 1;
    s.state = this.preparing ? 'preparing'
      : this.countdownLeft > 0 ? 'countdown'
      : player.playing ? 'playing'
      : ended ? 'ended' : 'paused';
    if (this.session === 'text' && this.doc) {
      const { words, groups } = this.doc;
      const w = words[this.reader.index];
      const g = this.settings.chunk > 1 && groups ? groups[w.group] : null;
      s.text = g ? words.slice(g.start, g.end).map((x) => x.text).join(' ') : w?.text ?? '';
      s.progress = words.length > 1 ? this.reader.index / (words.length - 1) : 1;
    } else if (this.session === 'vocab') {
      s.text = this.vocab.current?.item.word ?? '';
      s.progress = this.vocab.seq.length ? (this.vocab.index + 1) / this.vocab.seq.length : 0;
    }
    return s;
  }

  emitStatus() {
    this.onStatus?.(this.status());
  }
}
