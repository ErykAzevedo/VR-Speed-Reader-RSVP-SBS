// Página do celular (vr.html): só a tela do VR. As configurações, o texto e a
// lista de vocabulário chegam do painel; o celular devolve o que está tocando.

import { store, loadSettings } from './store.js';
import { hasSpeech, englishVoices } from './reader.js';
import { ImageStore, sessionItems } from './vocab.js';
import { VrEngine } from './engine.js';
import { PhoneLink } from './link.js';

const $ = (id) => document.getElementById(id);

const settings = loadSettings();
const saveSettings = () => store.set('settings', settings);
let vocabItems = store.get('phone:vocab', []);
let link = null; // criado logo abaixo do motor (o motor já avisa o status ao nascer)
let statusTimer = null;

const images = new ImageStore(() => sendStatus());

const engine = new VrEngine({
  root: $('vr'),
  settings,
  store,
  images,
  exitMode: 'idle', // toque longo / Esc só para a leitura; o celular continua no óculos
  onSettingsChange(patch, note) {
    saveSettings();
    link?.send({ type: 'settings', patch, note });
  },
  onStatus: () => sendStatus(),
  onExit() {
    $('setup').hidden = false;
  },
});

link = new PhoneLink({
  onState: renderLink,
  onOpen: sendHello,
  onMessage: handle,
});

// ---------------- mensagens do painel ----------------

const ACTIONS = new Set(['toggle', 'next', 'prev', 'faster', 'slower']);

function handle(msg) {
  switch (msg?.type) {
    case 'settings':
      Object.assign(settings, msg.settings);
      saveSettings();
      engine.applySettings();
      break;
    case 'text':
      store.set('text', msg.text);
      engine.setText(msg.text);
      sendStatus();
      break;
    case 'vocab':
      vocabItems = Array.isArray(msg.items) ? msg.items : [];
      store.set('phone:vocab', vocabItems);
      preloadImages();
      sendStatus();
      break;
    case 'start':
      start(msg.kind);
      break;
    case 'action':
      if (msg.action === 'stop') engine.stop();
      else if (ACTIONS.has(msg.action)) engine.actions[msg.action]();
      break;
    case 'restart':
      engine.restart();
      sendStatus();
      break;
    case 'testVoice':
      testVoice();
      break;
    default:
      break;
  }
}

function start(kind) {
  if (!engine.inVr) {
    notice('Toque em "Começar" no celular antes de iniciar.');
    return;
  }
  if (kind === 'text') {
    if (!engine.doc?.words.length) return notice('O celular ainda não recebeu o texto.');
    engine.start('text');
  } else if (kind === 'vocab') {
    const items = sessionItems(vocabItems, settings.vocabMode, images);
    if (!items.length) {
      return notice(settings.vocabMode === 'image'
        ? 'Nenhuma imagem da lista carregou no celular.'
        : 'A lista de vocabulário está vazia.');
    }
    engine.start('vocab', items);
  }
}

function notice(text) {
  link.send({ type: 'notice', text });
}

function preloadImages() {
  for (const item of vocabItems) if (item.url) images.load(item.url);
}

function testVoice() {
  if (!hasSpeech()) return notice('Este celular não tem síntese de voz.');
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance('This is how your reading voice sounds.');
  u.voice = engine.reader.voice;
  u.lang = engine.reader.voice?.lang || 'en-US';
  u.rate = engine.reader.rate;
  let boundaries = 0;
  u.onboundary = (e) => {
    if (!e.name || e.name === 'word') boundaries++;
  };
  u.onend = () => link.send({ type: 'voiceTest', exact: boundaries > 1 });
  u.onerror = (e) => link.send({ type: 'voiceTest', error: e.error });
  speechSynthesis.speak(u);
}

// ---------------- mensagens para o painel ----------------

function voiceList() {
  return englishVoices().map((v) => ({
    uri: v.voiceURI, name: v.name, lang: v.lang, local: v.localService, default: v.default,
  }));
}

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  const android = ua.match(/Android [\d.]+; ([^;)]+)/);
  if (android) return android[1].replace(/ Build.*/, '').trim() || 'Android';
  return 'Celular';
}

function sendHello() {
  link.send({
    type: 'hello',
    device: deviceName(),
    voices: voiceList(),
    secure: window.isSecureContext,
    speech: hasSpeech(),
  });
  sendStatus();
}

function imageSummary() {
  const s = { total: 0, ok: 0, loading: 0, failed: 0 };
  for (const item of vocabItems) {
    if (!item.url) continue;
    s.total++;
    const state = images.state(item.url);
    if (state === 'ok') s.ok++;
    else if (state === 'error') s.failed++;
    else s.loading++;
  }
  return s;
}

// várias mudanças por segundo durante a leitura: manda no máximo ~8 por segundo
function sendStatus() {
  if (statusTimer || !link?.connected) return;
  statusTimer = setTimeout(() => {
    statusTimer = null;
    link.send({ type: 'status', status: engine.status(), position: engine.position, images: imageSummary() });
  }, 120);
}

if (hasSpeech()) {
  speechSynthesis.addEventListener?.('voiceschanged', () => link.send({ type: 'voices', voices: voiceList() }));
}

// ---------------- tela inicial ----------------

const LINK_TEXT = {
  unavailable: 'Não deu para carregar o pareamento (sem internet?)',
  'no-code': 'Digite o código que aparece no painel',
  searching: 'Procurando o painel…',
  connected: 'Conectado ao painel',
  offline: 'Sem conexão com o servidor de pareamento. Tentando de novo…',
};

function renderLink(state) {
  $('linkState').dataset.state = state;
  const code = link.code ? ` (código ${link.code})` : '';
  $('linkText').textContent = LINK_TEXT[state] + (state === 'searching' ? code : '');
  if (state === 'connected') {
    engine.setIdle('Conectado', 'Inicie a leitura pelo painel');
  } else if (state === 'searching') {
    engine.setIdle('Procurando o painel', `Código ${link.code} · abra o painel no outro aparelho`);
  } else {
    engine.setIdle('Sem painel', LINK_TEXT[state]);
  }
}

$('codeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('code').value.replace(/\D/g, '');
  if (code.length !== 6) {
    $('code').focus();
    return;
  }
  store.set('phone:code', code);
  link.connect(code);
});

$('begin').addEventListener('click', () => {
  engine.unlock({ motion: true });
  $('setup').hidden = true;
  engine.show();
  sendStatus();
});

function checkEnvironment() {
  const notes = [];
  if (!hasSpeech()) notes.push('Este navegador não tem síntese de voz: a leitura será só visual.');
  if (!window.isSecureContext) notes.push('Aberto sem HTTPS: "manter a tela ligada" e os gestos de cabeça podem não funcionar.');
  if (!document.documentElement.requestFullscreen) {
    notes.push('Sem tela cheia neste navegador. No iPhone: Compartilhar → Adicionar à Tela de Início, e abra pelo ícone.');
  }
  $('warnings').textContent = notes.join('\n');
}

// ---------------- início ----------------

checkEnvironment();
const fromUrl = new URLSearchParams(location.search).get('c')?.replace(/\D/g, '');
if (fromUrl?.length === 6) {
  store.set('phone:code', fromUrl);
  history.replaceState(null, '', location.pathname); // tira o código da barra de endereço
}
const code = store.get('phone:code', '');
$('code').value = code;
const savedText = store.get('text', '');
if (savedText) engine.setText(savedText);
preloadImages();
link.connect(code);
