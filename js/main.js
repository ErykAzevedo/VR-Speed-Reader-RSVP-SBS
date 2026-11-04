import { parseText, textHash } from './text.js';
import { Reader, hasSpeech } from './reader.js';
import { SbsView } from './sbs.js';
import { Controls, HeadGestures } from './input.js';

const $ = (id) => document.getElementById(id);

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`vrsr:${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`vrsr:${key}`, JSON.stringify(value));
    } catch {
      /* armazenamento cheio ou bloqueado: segue sem salvar */
    }
  },
};

const DEFAULTS = {
  wpm: 200, font: 46, context: false,
  audio: true, voiceURI: '',
  mode: 'sbs', shiftX: 0, shiftY: 0, countdown: 5, head: false, headInvert: false,
};
const settings = { ...DEFAULTS, ...store.get('settings', {}) };
const saveSettings = () => store.set('settings', settings);

const SAMPLE = `Welcome to your VR speed reader. Each word appears in the same spot, so your eyes can rest while your mind does the work. The red letter marks the point where your eye naturally lands, which helps you recognize each word a little faster.

At the same time, a voice reads the text aloud, so you see and hear every word together. This combination is great for building listening skills and vocabulary in English.

Start slowly, around two hundred words per minute, and increase the speed as it becomes comfortable. If you lose track of an idea, tilt your head to the left or press back to repeat the sentence. Take a short break every twenty minutes to rest your eyes. Enjoy your reading!`;

// ---------------- estado ----------------

const view = new SbsView($('vr'));
let doc = null;
let docHash = '';
let lastSaved = 0;
let inVr = false;
let wentFullscreen = false;
let wakeLock = null;
let countdownLeft = 0;
let countdownTimer = null;

const reader = new Reader({
  onWord(i) {
    if (inVr) renderWord(i);
    if (Date.now() - lastSaved > 5000) savePosition();
  },
  onState(state) {
    view.setPaused(state !== 'playing');
    if (state !== 'playing') {
      savePosition();
      if (inVr) renderWord(reader.index);
    }
    if (state === 'ended') view.flash('✓ fim');
    renderStatus();
  },
  onStats(info) {
    if (info?.audioError) {
      settings.audio = false;
      $('audio').checked = false;
      saveSettings();
      warn(`A voz falhou (${info.audioError}); a leitura continuou sem áudio.`);
    }
    renderStatus();
  },
});
reader.setWpm(settings.wpm);
reader.audio = settings.audio && hasSpeech();

// ---------------- render ----------------

function renderWord(i) {
  const w = doc?.words[i];
  if (!w) return;
  view.showWord(w.text);
  const chunk = doc.chunks[w.chunk];
  if (settings.context || !reader.playing) view.showContext(doc.words, chunk.start, chunk.end, i);
  view.setProgress(doc.words.length > 1 ? i / (doc.words.length - 1) : 1);
}

function renderStatus() {
  if (!doc) return;
  const pct = Math.round((reader.index / Math.max(1, doc.words.length - 1)) * 100);
  const atEnd = reader.index >= doc.words.length - 1;
  const state = countdownLeft > 0 ? `Começando em ${countdownLeft}…`
    : reader.playing ? '▶'
    : atEnd ? '✓ Fim' : '⏸ Pausado';
  const audio = reader.audio ? ' · 🔊' : '';
  view.setStatus(`${state} · ${pct}% · ${reader.effectiveWpm} wpm${audio}`);
}

function renderTextInfo() {
  const n = doc?.words.length ?? 0;
  const left = n - reader.index;
  $('textInfo').textContent = n ? `${n.toLocaleString('pt-BR')} palavras` : '';
  $('posInfo').textContent = n
    ? `Posição: ${Math.round((reader.index / Math.max(1, n - 1)) * 100)}% · faltam ~${Math.max(1, Math.round(left / settings.wpm))} min`
    : '';
  $('restart').hidden = !n || reader.index === 0;
}

function warn(msg) {
  $('warnings').textContent = msg;
}

// ---------------- texto e posição ----------------

function setText(raw) {
  doc = parseText(raw);
  docHash = textHash(raw);
  const saved = store.get('pos', null);
  reader.load(doc, saved?.hash === docHash ? saved.index : 0);
  store.set('text', raw);
  renderTextInfo();
}

function savePosition() {
  if (!doc) return;
  store.set('pos', { hash: docHash, index: reader.index });
  lastSaved = Date.now();
}

let typingTimer = null;
$('text').addEventListener('input', () => {
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => setText($('text').value), 400);
});

$('file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  $('text').value = await file.text();
  setText($('text').value);
  e.target.value = '';
});

$('sample').addEventListener('click', () => {
  $('text').value = SAMPLE;
  setText(SAMPLE);
});

$('restart').addEventListener('click', () => {
  reader.seek(0);
  savePosition();
  renderTextInfo();
});

// ---------------- configurações ----------------

function bindRange(id, key, format, onChange) {
  const input = $(id);
  const out = $(`${id}Out`);
  input.value = settings[key];
  out.textContent = format(settings[key]);
  input.addEventListener('input', () => {
    settings[key] = Number(input.value);
    out.textContent = format(settings[key]);
    onChange?.(settings[key]);
    saveSettings();
  });
}

function bindCheck(id, key, onChange) {
  const input = $(id);
  input.checked = settings[key];
  input.addEventListener('change', () => {
    settings[key] = input.checked;
    onChange?.(input.checked);
    saveSettings();
  });
}

bindRange('wpm', 'wpm', String, (v) => {
  reader.setWpm(v);
  renderTextInfo();
});
bindRange('font', 'font', (v) => `${v}px`);
bindRange('shiftX', 'shiftX', (v) => `${v > 0 ? '+' : ''}${v}px`);
bindRange('shiftY', 'shiftY', (v) => `${v > 0 ? '+' : ''}${v}px`);
bindRange('countdown', 'countdown', (v) => (v ? `${v}s` : 'começa na hora'));
bindCheck('context', 'context');
bindCheck('audio', 'audio', (on) => reader.setAudio(on && hasSpeech()));
bindCheck('head', 'head', (on) => ($('headInvert').disabled = !on));
bindCheck('headInvert', 'headInvert');
$('headInvert').disabled = !settings.head;

$('mode').value = settings.mode;
$('mode').addEventListener('change', () => {
  settings.mode = $('mode').value;
  saveSettings();
});

function changeWpm(delta) {
  reader.setWpm(reader.wpm + delta);
  settings.wpm = reader.wpm;
  $('wpm').value = settings.wpm;
  $('wpmOut').textContent = settings.wpm;
  saveSettings();
  view.flash(`${settings.wpm} wpm`);
}

// ---------------- vozes ----------------

let voices = [];

function loadVoices() {
  if (!hasSpeech()) return;
  voices = speechSynthesis
    .getVoices()
    .filter((v) => /^en([-_]|$)/i.test(v.lang))
    .sort((a, b) =>
      (b.lang.replace('_', '-') === 'en-US') - (a.lang.replace('_', '-') === 'en-US')
      || b.localService - a.localService
      || a.name.localeCompare(b.name));
  const select = $('voice');
  select.replaceChildren(...voices.map((v) => {
    const opt = document.createElement('option');
    opt.value = v.voiceURI;
    opt.textContent = `${v.name} (${v.lang})${v.localService ? '' : ' · online'}`;
    return opt;
  }));
  const chosen = voices.find((v) => v.voiceURI === settings.voiceURI)
    ?? voices.find((v) => v.default)
    ?? voices[0];
  if (chosen) select.value = chosen.voiceURI;
  reader.setVoice(chosen ?? null);
  if (!voices.length) $('voiceInfo').textContent = 'Nenhuma voz em inglês encontrada (será usada a voz padrão).';
}

$('voice').addEventListener('change', () => {
  settings.voiceURI = $('voice').value;
  saveSettings();
  reader.setVoice(voices.find((v) => v.voiceURI === settings.voiceURI) ?? null);
  $('voiceInfo').textContent = '';
});

$('testVoice').addEventListener('click', () => {
  if (!hasSpeech()) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance('This is how your reading voice sounds.');
  u.voice = reader.voice;
  u.lang = reader.voice?.lang || 'en-US';
  u.rate = reader.rate;
  let boundaries = 0;
  u.onboundary = (e) => {
    if (!e.name || e.name === 'word') boundaries++;
  };
  u.onend = () => {
    $('voiceInfo').textContent = boundaries > 1
      ? '✓ Sincronia exata (a voz informa cada palavra)'
      : 'Sincronia estimada (esta voz não informa as palavras)';
  };
  u.onerror = (e) => ($('voiceInfo').textContent = `Erro na voz: ${e.error}`);
  $('voiceInfo').textContent = 'Falando…';
  speechSynthesis.speak(u);
});

// ---------------- modo VR ----------------

const actions = {
  toggle() {
    if (countdownLeft > 0) {
      cancelCountdown();
      reader.play();
    } else {
      reader.toggle();
    }
    view.flash(reader.playing ? '▶' : '⏸');
  },
  next() {
    cancelCountdown();
    reader.nextChunk();
    view.flash('⏭');
  },
  prev() {
    cancelCountdown();
    reader.prevChunk();
    view.flash('⏮');
  },
  faster: () => changeWpm(+20),
  slower: () => changeWpm(-20),
  exit: () => exitVr(),
};

const controls = new Controls($('vr'), actions);
const head = new HeadGestures((gesture) => actions[gesture]());

$('start').addEventListener('click', enterVr);

async function enterVr() {
  if (!doc?.words.length) {
    warn('Cole ou abra um texto em inglês primeiro.');
    return;
  }
  warn('');

  // Tudo que exige gesto do usuário é disparado aqui, antes de qualquer await.
  if (reader.audio) {
    const unlock = new SpeechSynthesisUtterance(' ');
    unlock.volume = 0;
    speechSynthesis.speak(unlock);
  }
  const headAllowed = settings.head ? HeadGestures.requestPermission() : Promise.resolve(false);
  const fullscreen = document.documentElement.requestFullscreen
    ? document.documentElement.requestFullscreen({ navigationUI: 'hide' }).then(() => true, () => false)
    : Promise.resolve(false);

  inVr = true;
  document.activeElement?.blur(); // evita que Espaço/Enter "clique" de novo no botão
  $('setup').hidden = true;
  $('vr').hidden = false;
  view.apply({
    fontSize: settings.font,
    shiftX: settings.shiftX,
    shiftY: settings.shiftY,
    mono: settings.mode === 'mono',
    showContext: settings.context,
  });
  view.setPaused(true);
  renderWord(reader.index);
  controls.start();
  startCountdown();

  wentFullscreen = await fullscreen;
  if (wentFullscreen) screen.orientation?.lock?.('landscape').catch(() => {});
  requestWakeLock();

  if (await headAllowed) {
    head.invert = settings.headInvert;
    // o "neutro" da cabeça é medido depois que o celular já está no VR Box
    head.start(Math.max(1500, settings.countdown * 1000));
  } else if (settings.head) {
    view.flash('sem sensor');
  }
}

function exitVr() {
  if (!inVr) return;
  inVr = false;
  cancelCountdown();
  reader.pause();
  controls.stop();
  head.stop();
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  try {
    screen.orientation?.unlock?.();
  } catch {
    /* sem suporte */
  }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $('vr').hidden = true;
  $('setup').hidden = false;
  savePosition();
  renderTextInfo();
}

function startCountdown() {
  cancelCountdown();
  countdownLeft = settings.countdown;
  if (!countdownLeft) {
    reader.play();
    return;
  }
  renderStatus();
  countdownTimer = setInterval(() => {
    countdownLeft--;
    renderStatus();
    if (countdownLeft <= 0) {
      cancelCountdown();
      reader.play();
    }
  }, 1000);
}

function cancelCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = null;
  countdownLeft = 0;
}

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    wakeLock = null;
  }
}

document.addEventListener('fullscreenchange', () => {
  // botão Voltar do Android sai da tela cheia: sai do VR junto
  if (!document.fullscreenElement && inVr && wentFullscreen) exitVr();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    reader.pause();
    savePosition();
  } else if (inVr) {
    requestWakeLock();
  }
});

window.addEventListener('resize', () => {
  if (inVr) renderWord(reader.index);
});

// ---------------- início ----------------

function checkEnvironment() {
  const notes = [];
  if (!hasSpeech()) {
    notes.push('Este navegador não tem síntese de voz: a leitura será só visual.');
    $('audio').checked = false;
    $('audio').disabled = true;
    reader.audio = false;
  }
  if (!window.isSecureContext) {
    notes.push('Aberto sem HTTPS: "manter a tela ligada" e os gestos de cabeça podem não funcionar (veja o README).');
  }
  if (!document.documentElement.requestFullscreen) {
    notes.push('Sem tela cheia neste navegador. No iPhone: Compartilhar → Adicionar à Tela de Início, e abra pelo ícone.');
  }
  warn(notes.join('\n'));
}

checkEnvironment();
if (hasSpeech()) {
  loadVoices();
  speechSynthesis.onvoiceschanged = loadVoices;
}
$('text').value = store.get('text', '') || SAMPLE;
setText($('text').value);
