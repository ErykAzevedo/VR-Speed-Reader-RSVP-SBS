// Painel: texto, listas e configurações. Com o celular pareado (vr.html), tudo
// é enviado para ele na hora e o painel vira controle remoto; sem celular, o
// VR abre neste mesmo aparelho.

import { store, loadSettings } from './store.js';
import { hasSpeech, englishVoices } from './reader.js';
import { ImageStore } from './vocab.js';
import { initVocabUI } from './vocab-ui.js';
import { VrEngine } from './engine.js';
import { PanelLink, newCode } from './link.js';

const $ = (id) => document.getElementById(id);

const settings = loadSettings();

const SAMPLE = `Welcome to your VR speed reader. Each word appears in the same spot, so your eyes can rest while your mind does the work. The red letter marks the point where your eye naturally lands, which helps you recognize each word a little faster.

At the same time, a voice reads the text aloud, so you see and hear every word together. This combination is great for building listening skills and vocabulary in English.

Start slowly, around two hundred words per minute, and increase the speed as it becomes comfortable. If you lose track of an idea, tilt your head to the left or press back to repeat the sentence. Take a short break every twenty minutes to rest your eyes. Enjoy your reading!`;

// ---------------- estado ----------------

let vocabUI = null;
let currentText = '';
let phone = null; // { device } do celular conectado
let phoneVoices = null; // vozes do celular conectado
let phoneStatus = null; // o que está tocando no celular
let phonePosition = null; // posição de leitura no celular { index, total, hash }
let showQr = false;

const images = new ImageStore(() => vocabUI?.refresh());

const engine = new VrEngine({
  root: $('vr'),
  settings,
  store,
  images,
  onSettingsChange(patch, note) {
    // mudou dentro do VR deste aparelho (controle, voz que falhou)
    store.set('settings', settings);
    syncUI();
    if (note) warn(note);
  },
  onExit() {
    $('setup').hidden = false;
    renderTextInfo();
  },
});

const link = new PanelLink({
  onState(state) {
    // o "hello" do celular pode chegar antes de a conexão contar como aberta:
    // só esquece o aparelho quando a conexão cai de fato
    if (state !== 'connected') forgetPhone();
    renderPair(state);
  },
  onConnect: sendEverything,
  onMessage: handlePhone,
});

function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  return () => {
    clearTimeout(timer);
    const wait = last + ms - Date.now();
    if (wait <= 0) {
      last = Date.now();
      fn();
    } else {
      timer = setTimeout(() => {
        last = Date.now();
        fn();
      }, wait);
    }
  };
}

// arrastar um controle manda várias atualizações por segundo, sem esperar soltar
const pushSettings = throttle(() => link.send({ type: 'settings', settings }), 80);

function saveSettings() {
  store.set('settings', settings);
  engine.applySettings();
  pushSettings();
}

function warn(msg) {
  $('warnings').textContent = msg;
}

// ---------------- celular: pareamento ----------------

const PAIR_TEXT = {
  unavailable: 'Pareamento indisponível (sem internet?)',
  starting: 'Registrando o código…',
  waiting: 'Aguardando o celular',
  connected: 'Celular conectado',
  offline: 'Sem conexão com o servidor. Tentando de novo…',
  taken: 'Código em uso. Gere outro código.',
};

function setupPairing(code) {
  store.set('panel:code', code);
  const url = new URL(`vr.html?c=${code}`, location.href).href;
  $('pairCode').textContent = code;
  $('phoneLink').href = url;
  $('phoneLink').textContent = url.replace(/^https?:\/\//, '').replace(/\?.*$/, '');
  if (window.qrcode) {
    const qr = window.qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    $('qr').innerHTML = qr.createSvgTag(4, 8);
    $('qr').setAttribute('role', 'img');
    $('qr').setAttribute('aria-label', `QR code para abrir ${url}`);
  } else {
    $('qr').textContent = 'QR code indisponível';
  }
  const local = /^(localhost|127\.|\[::1\])/.test(location.hostname);
  $('pairNote').textContent = local
    ? 'Este painel está em localhost: o celular não abre esse endereço. Use o site publicado ou o IP deste computador na rede.'
    : '';
  link.start(code);
}

function forgetPhone() {
  phone = null;
  phoneVoices = null;
  phoneStatus = null;
  phonePosition = null;
  vocabUI?.setPhoneSummary('');
}

function renderPair(state) {
  const connected = state === 'connected';
  $('pairState').dataset.state = state;
  $('pairText').textContent = connected && phone ? `${phone.device} conectado` : PAIR_TEXT[state] ?? state;
  $('pairBody').hidden = connected && !showQr;
  $('pairToggle').hidden = !connected;
  $('pairToggle').textContent = showQr ? 'Esconder QR code' : 'Mostrar QR code';
  const startLabel = connected ? '▶ Iniciar no celular' : '▶ Entrar no VR';
  $('start').textContent = startLabel;
  $('vocabStart').textContent = startLabel;
  document.body.classList.toggle('connected', connected);
  $('remote').hidden = !connected;
  if (connected) document.body.style.setProperty('--remote-h', `${$('remote').offsetHeight}px`);
  else document.body.style.removeProperty('--remote-h');
  renderRemote();
  renderVoiceSelect();
  renderTextInfo();
}

$('newCode').addEventListener('click', () => setupPairing(newCode()));
$('pairToggle').addEventListener('click', () => {
  showQr = !showQr;
  renderPair(link.state);
});

/** Ao conectar: o celular recebe as configurações, o texto e a lista atuais. */
function sendEverything() {
  link.send({ type: 'settings', settings });
  link.send({ type: 'text', text: currentText });
  link.send({ type: 'vocab', items: vocabUI.listItems() });
}

// só estes campos podem ser alterados pelo celular (controle remoto/gestos e voz que falhou)
const PHONE_EDITABLE = ['wpm', 'vocabPace', 'audio'];

function handlePhone(msg) {
  switch (msg?.type) {
    case 'hello':
      phone = { device: String(msg.device || 'Celular') };
      phoneVoices = Array.isArray(msg.voices) && msg.voices.length ? msg.voices : null;
      renderPair(link.state);
      break;
    case 'voices':
      phoneVoices = Array.isArray(msg.voices) && msg.voices.length ? msg.voices : null;
      renderVoiceSelect();
      break;
    case 'status':
      phoneStatus = msg.status ?? null;
      phonePosition = msg.position ?? null;
      renderRemote();
      renderTextInfo();
      renderPhoneImages(msg.images);
      break;
    case 'settings': {
      let changed = false;
      for (const key of PHONE_EDITABLE) {
        if (msg.patch && key in msg.patch && typeof msg.patch[key] === typeof settings[key]) {
          settings[key] = msg.patch[key];
          changed = true;
        }
      }
      if (changed) {
        store.set('settings', settings);
        engine.applySettings();
        syncUI();
      }
      if (msg.note) warn(String(msg.note));
      break;
    }
    case 'notice':
      warn(String(msg.text));
      $('remoteLabel').textContent = String(msg.text);
      break;
    case 'voiceTest':
      $('voiceInfo').textContent = msg.error ? `Erro na voz do celular: ${msg.error}`
        : msg.exact ? '✓ Sincronia exata no celular (a voz informa cada palavra)'
        : 'Sincronia estimada no celular (esta voz não informa as palavras)';
      break;
    default:
      break;
  }
}

// ---------------- celular: controle remoto ----------------

for (const button of document.querySelectorAll('[data-remote]')) {
  button.addEventListener('click', () => link.send({ type: 'action', action: button.dataset.remote }));
}

function renderRemote() {
  const st = phoneStatus;
  $('remote').classList.toggle('playing', st?.state === 'playing');
  $('remoteDevice').textContent = phone?.device ?? '';
  let label;
  let text = '—';
  let progress = 0;
  if (!st?.inVr) {
    label = 'No celular, toque em "Começar" e encaixe no VR Box';
  } else if (!st.session) {
    label = 'Pronto no VR · escolha o texto ou a lista e toque em Iniciar';
  } else {
    label = st.label || '';
    text = st.text || '—';
    progress = st.progress || 0;
  }
  $('remoteLabel').textContent = label;
  $('remoteText').textContent = text;
  $('remoteBar').style.width = `${(progress * 100).toFixed(1)}%`;
}

function renderPhoneImages(s) {
  if (!vocabUI) return;
  if (!s?.total) return vocabUI.setPhoneSummary('');
  vocabUI.setPhoneSummary([
    `No celular: ${s.ok} de ${s.total} prontas`,
    s.loading && `${s.loading} baixando`,
    s.failed && `${s.failed} ${s.failed === 1 ? 'falhou' : 'falharam'}`,
  ].filter(Boolean).join(' · '));
}

// ---------------- iniciar ----------------

function start(kind) {
  if (kind === 'text' && !engine.doc?.words.length) {
    warn('Cole ou abra um texto em inglês primeiro.');
    return;
  }
  const items = kind === 'vocab' ? vocabUI.sessionItems() : null;
  if (kind === 'vocab' && !items.length) {
    warn(settings.vocabMode === 'image' ? 'Nenhuma palavra da lista tem imagem carregada.' : 'A lista está vazia.');
    return;
  }
  warn('');

  if (link.connected) {
    // garante que o celular está com o conteúdo e as configurações de agora
    link.send({ type: 'settings', settings });
    if (kind === 'text') link.send({ type: 'text', text: currentText });
    else link.send({ type: 'vocab', items: vocabUI.listItems() });
    link.send({ type: 'start', kind });
    return;
  }

  // sem celular: abre o VR aqui mesmo (unlock precisa vir antes de qualquer espera)
  engine.unlock();
  $('setup').hidden = true;
  engine.show();
  engine.start(kind, items);
}

$('start').addEventListener('click', () => start('text'));

// ---------------- abas ----------------

function showTab(tab) {
  settings.tab = tab;
  store.set('settings', settings);
  for (const button of document.querySelectorAll('.tabs [role="tab"]')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === tab));
  }
  $('panelText').hidden = tab !== 'text';
  $('panelVocab').hidden = tab !== 'vocab';
  $('start').hidden = tab !== 'text';
}

for (const button of document.querySelectorAll('.tabs [role="tab"]')) {
  button.addEventListener('click', () => showTab(button.dataset.tab));
}

// ---------------- texto e posição ----------------

function setText(raw) {
  currentText = raw;
  store.set('text', raw);
  engine.setText(raw);
  renderTextInfo();
  link.send({ type: 'text', text: raw });
}

function renderTextInfo() {
  const n = engine.doc?.words.length ?? 0;
  const remote = link.connected && phonePosition?.hash === engine.docHash ? phonePosition : null;
  const index = remote ? remote.index : engine.reader.index;
  $('textInfo').textContent = n ? `${n.toLocaleString('pt-BR')} palavras` : '';
  $('posInfo').textContent = n
    ? `${remote ? 'No celular' : 'Posição'}: ${Math.round((index / Math.max(1, n - 1)) * 100)}% · faltam ~${Math.max(1, Math.round((n - index) / settings.wpm))} min`
    : '';
  $('restart').hidden = !n || index === 0;
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
  engine.restart();
  link.send({ type: 'restart' });
  renderTextInfo();
});

// ---------------- configurações ----------------

const syncers = [];

function bindRange(id, key, format, onChange) {
  const input = $(id);
  const out = $(`${id}Out`);
  const sync = () => {
    input.value = settings[key];
    out.textContent = format(settings[key]);
  };
  syncers.push(sync);
  input.addEventListener('input', () => {
    settings[key] = Number(input.value);
    out.textContent = format(settings[key]);
    saveSettings();
    onChange?.();
  });
}

function bindCheck(id, key) {
  const input = $(id);
  syncers.push(() => (input.checked = settings[key]));
  input.addEventListener('change', () => {
    settings[key] = input.checked;
    saveSettings();
    syncUI();
  });
}

bindRange('wpm', 'wpm', String, renderTextInfo);
bindRange('font', 'font', (v) => `${v}px`);
bindRange('shiftX', 'shiftX', (v) => `${v > 0 ? '+' : ''}${v}px`);
bindRange('shiftY', 'shiftY', (v) => `${v > 0 ? '+' : ''}${v}px`);
bindRange('countdown', 'countdown', (v) => (v ? `${v}s` : 'começa na hora'));
bindCheck('context', 'context');
bindCheck('audio', 'audio');
bindCheck('head', 'head');
bindCheck('headInvert', 'headInvert');

$('mode').addEventListener('change', () => {
  settings.mode = $('mode').value;
  saveSettings();
});

for (const button of document.querySelectorAll('[data-chunk]')) {
  button.addEventListener('click', () => {
    settings.chunk = Number(button.dataset.chunk);
    saveSettings();
    syncUI();
  });
}

/** Mostra nos controles o que está em `settings` (mudou pelo celular ou pelo VR). */
function syncUI() {
  for (const sync of syncers) sync();
  $('mode').value = settings.mode;
  $('headInvert').disabled = !settings.head;
  for (const button of document.querySelectorAll('[data-chunk]')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.chunk) === settings.chunk));
  }
  $('chunkHint').textContent = settings.chunk === 1
    ? 'Uma palavra por vez, com a letra de foco em vermelho.'
    : `Blocos de até ${settings.chunk} palavras, agrupados por sentido. A palavra falada fica sublinhada.`;
  vocabUI?.refresh();
  renderTextInfo();
}

// ---------------- vozes ----------------

/** Com o celular conectado, a lista mostra as vozes DELE (cada aparelho tem as suas). */
function renderVoiceSelect() {
  const list = phoneVoices ?? englishVoices().map((v) => ({
    uri: v.voiceURI, name: v.name, lang: v.lang, local: v.localService, default: v.default,
  }));
  const select = $('voice');
  select.replaceChildren(...list.map((v) => {
    const opt = document.createElement('option');
    opt.value = v.uri;
    opt.textContent = `${v.name} (${v.lang})${v.local ? '' : ' · online'}`;
    return opt;
  }));
  const chosen = list.find((v) => v.uri === settings.voiceURI) ?? list.find((v) => v.default) ?? list[0];
  if (chosen) select.value = chosen.uri;
  $('voiceSource').textContent = phoneVoices ? '· vozes do celular' : '';
  // no Chrome as vozes chegam depois (voiceschanged): a lista vazia inicial não é definitiva
  if (!phoneVoices) $('voiceInfo').textContent = list.length ? '' : 'Nenhuma voz em inglês encontrada (será usada a voz padrão).';
}

$('voice').addEventListener('change', () => {
  settings.voiceURI = $('voice').value;
  saveSettings();
  $('voiceInfo').textContent = '';
});

function speakOnce(text, rate = engine.reader.rate) {
  if (!hasSpeech()) return null;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.voice = engine.reader.voice;
  u.lang = engine.reader.voice?.lang || 'en-US';
  u.rate = rate;
  speechSynthesis.speak(u);
  return u;
}

$('testVoice').addEventListener('click', () => {
  if (link.connected) {
    link.send({ type: 'testVoice' });
    $('voiceInfo').textContent = 'Falando no celular…';
    return;
  }
  const u = speakOnce('This is how your reading voice sounds.');
  if (!u) return;
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
});

// ---------------- início ----------------

function checkEnvironment() {
  const notes = [];
  if (!hasSpeech()) notes.push('Este navegador não tem síntese de voz: sem celular pareado, a leitura será só visual.');
  if (!window.Peer) notes.push('Não deu para carregar o pareamento com o celular (sem internet?). O VR ainda abre neste aparelho.');
  warn(notes.join('\n'));
}

checkEnvironment();
if (hasSpeech()) speechSynthesis.addEventListener?.('voiceschanged', renderVoiceSelect);
$('text').value = store.get('text', '') || SAMPLE;
setText($('text').value);

vocabUI = initVocabUI({
  store,
  settings,
  saveSettings,
  images,
  speak: (word) => speakOnce(word, 0.9),
  onStart: () => start('vocab'),
  onListChange: (items) => link.send({ type: 'vocab', items }),
});
showTab(settings.tab);
syncUI();
renderVoiceSelect();
setupPairing(store.get('panel:code', null) ?? newCode());
window.addEventListener('resize', () => {
  if (link.connected) document.body.style.setProperty('--remote-h', `${$('remote').offsetHeight}px`);
});
