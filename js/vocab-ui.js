// Aba "Vocabulário": listas de palavras com link de imagem e a configuração
// da sessão (modo, repetições, tempo por palavra).

import { parseVocabLines, sessionItems } from './vocab.js';

const $ = (id) => document.getElementById(id);

// SVGs fixos (nunca recebem texto do usuário)
const svg = (body, size = 20, width = 1.8) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
  image: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>', 22, 1.6),
  check: svg('<path d="M5 12l4 4 10-10"/>', 12, 3),
  loading: svg('<path d="M12 3a9 9 0 1 1-9 9"/>', 12, 3),
  alert: svg('<path d="M12 6v7"/><path d="M12 18h.01"/>', 12, 3.2),
  speaker: svg('<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M18.5 6.5a8 8 0 0 1 0 11"/>'),
  trash: svg('<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>', 19),
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const newId = () => `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const emptyList = (name = 'Minha lista') => ({ id: newId(), name, items: [] });

function formatDuration(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
}

function listNames(words) {
  return words.length <= 3 ? words.join(', ') : `${words.slice(0, 2).join(', ')} e mais ${words.length - 2}`;
}

/**
 * @param {object} o
 * @param {{get: Function, set: Function}} o.store
 * @param {object} o.settings  vocabMode, vocabReps, vocabPace, vocabShuffle, vocabCaption
 * @param {import('./vocab.js').ImageStore} o.images
 * @param {(word: string) => void} o.speak
 * @param {() => void} o.onStart  entrar no VR com a lista atual
 * @param {(items: object[]) => void} [o.onListChange]  a lista atual mudou (para mandar ao celular)
 */
export function initVocabUI({ store, settings, saveSettings, images, speak, onStart, onListChange }) {
  let data = store.get('vocab', null);
  if (!data?.lists?.length) data = { lists: [emptyList()], current: null };
  if (!data.lists.some((l) => l.id === data.current)) data.current = data.lists[0].id;
  const list = () => data.lists.find((l) => l.id === data.current);
  const save = () => {
    store.set('vocab', data);
    onListChange?.(list().items);
  };

  // ---------- adicionar palavras ----------

  const paste = $('vocabPaste');
  const addButton = $('vocabAdd');

  function updateAddButton() {
    const n = parseVocabLines(paste.value).items.length;
    addButton.disabled = !n;
    addButton.textContent = n ? `Adicionar ${plural(n, 'palavra', 'palavras')}` : 'Adicionar';
  }

  paste.addEventListener('input', () => {
    $('vocabAddInfo').textContent = '';
    updateAddButton();
  });

  addButton.addEventListener('click', () => {
    const { items, skipped } = parseVocabLines(paste.value);
    const current = list();
    let added = 0;
    let updated = 0;
    for (const item of items) {
      const existing = current.items.find((x) => x.word.toLowerCase() === item.word.toLowerCase());
      if (!existing) {
        current.items.push(item);
        added++;
      } else if (item.url && item.url !== existing.url) {
        existing.url = item.url;
        updated++;
      }
    }
    save();
    paste.value = '';
    updateAddButton();
    $('vocabAddInfo').textContent = [
      added && plural(added, 'adicionada', 'adicionadas'),
      updated && plural(updated, 'atualizada', 'atualizadas'),
      skipped && plural(skipped, 'linha ignorada', 'linhas ignoradas'),
    ].filter(Boolean).join(' · ') || 'Essas palavras já estavam na lista.';
    render();
  });

  $('vocabFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    paste.value = await file.text();
    e.target.value = '';
    updateAddButton();
  });

  // ---------- listas ----------

  const select = $('vocabListSelect');
  select.addEventListener('change', () => {
    data.current = select.value;
    save();
    render();
  });

  $('vocabNewList').addEventListener('click', () => {
    const name = prompt('Nome da nova lista:')?.trim();
    if (!name) return;
    const l = emptyList(name);
    data.lists.push(l);
    data.current = l.id;
    save();
    render();
  });

  $('vocabDeleteList').addEventListener('click', () => {
    const l = list();
    if (!confirm(`Apagar a lista "${l.name}" (${plural(l.items.length, 'palavra', 'palavras')})?`)) return;
    data.lists = data.lists.filter((x) => x !== l);
    if (!data.lists.length) data.lists.push(emptyList());
    data.current = data.lists[0].id;
    save();
    for (const item of l.items) forgetIfUnused(item.url);
    render();
  });

  // ---------- itens ----------

  function forgetIfUnused(url) {
    if (url && !data.lists.some((l) => l.items.some((x) => x.url === url))) images.forget(url);
  }

  function editLink(item) {
    const input = prompt(`Link da imagem para "${item.word}":`, item.url || '');
    if (input == null) return;
    const url = input.trim();
    if (url && !/^https?:\/\/\S+$/i.test(url)) {
      alert('O link precisa começar com http:// ou https://');
      return;
    }
    const old = item.url;
    item.url = url;
    save();
    if (url && url === old) images.retry(url);
    else forgetIfUnused(old);
    render();
  }

  function removeItem(item) {
    const l = list();
    l.items = l.items.filter((x) => x !== item);
    save();
    forgetIfUnused(item.url);
    render();
  }

  function iconButton(icon, label, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon';
    b.innerHTML = icon;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', onClick);
    return b;
  }

  function itemRow(item) {
    const state = item.url ? images.state(item.url) : 'none';
    const li = document.createElement('li');
    li.className = 'vocab-item';
    li.dataset.state = state;

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (state === 'ok') {
      const img = document.createElement('img');
      img.alt = '';
      img.src = images.src(item.url);
      thumb.append(img);
    } else {
      thumb.innerHTML = ICONS.image;
    }
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.innerHTML = state === 'ok' ? ICONS.check : state === 'error' ? ICONS.alert : ICONS.loading;
    thumb.append(badge);

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'item-main';
    main.setAttribute('aria-label', `${item.word}: trocar o link da imagem`);
    const word = document.createElement('span');
    word.className = 'item-word';
    word.textContent = item.word;
    const sub = document.createElement('span');
    sub.className = 'item-sub';
    sub.textContent = state === 'error' ? 'Imagem não carregou · toque para trocar o link'
      : item.url || 'Sem imagem · toque para adicionar um link';
    main.append(word, sub);
    main.addEventListener('click', () => editLink(item));

    li.append(
      thumb,
      main,
      iconButton(ICONS.speaker, `Ouvir ${item.word}`, () => speak(item.word)),
      iconButton(ICONS.trash, `Remover ${item.word}`, () => removeItem(item)),
    );
    return li;
  }

  function stats(items) {
    const s = { total: items.length, withUrl: 0, ok: 0, loading: 0, failed: [], noUrl: 0 };
    for (const item of items) {
      if (!item.url) {
        s.noUrl++;
        continue;
      }
      s.withUrl++;
      const state = images.state(item.url);
      if (state === 'ok') s.ok++;
      else if (state === 'error') s.failed.push(item.word);
      else s.loading++;
    }
    return s;
  }

  // ---------- sessão ----------

  function showSession(on) {
    $('vocabList').hidden = on;
    $('vocabSession').hidden = !on;
    window.scrollTo(0, 0);
    render();
  }
  $('vocabConfigure').addEventListener('click', () => showSession(true));
  $('vocabBack').addEventListener('click', () => showSession(false));

  for (const button of document.querySelectorAll('#vocabSession .mode')) {
    button.addEventListener('click', () => {
      settings.vocabMode = button.dataset.mode;
      saveSettings();
      render();
    });
  }
  for (const button of document.querySelectorAll('#vocabSession [data-pace]')) {
    button.addEventListener('click', () => {
      settings.vocabPace = Number(button.dataset.pace);
      saveSettings();
      render();
    });
  }
  const stepReps = (d) => {
    settings.vocabReps = Math.min(20, Math.max(1, settings.vocabReps + d));
    saveSettings();
    render();
  };
  $('repsDec').addEventListener('click', () => stepReps(-1));
  $('repsInc').addEventListener('click', () => stepReps(+1));
  $('vocabShuffle').addEventListener('change', (e) => {
    settings.vocabShuffle = e.target.checked;
    saveSettings();
  });
  $('vocabCaption').addEventListener('change', (e) => {
    settings.vocabCaption = e.target.checked;
    saveSettings();
  });
  $('precacheRetry').addEventListener('click', () => {
    for (const item of list().items) if (item.url && images.state(item.url) === 'error') images.retry(item.url);
  });
  $('vocabStart').addEventListener('click', () => onStart());

  // ---------- render ----------

  function render() {
    const l = list();
    for (const item of l.items) if (item.url) images.load(item.url); // pré-carrega já na lista
    const s = stats(l.items);
    const image = settings.vocabMode === 'image';

    select.replaceChildren(...data.lists.map((x) => new Option(`${x.name} (${x.items.length})`, x.id)));
    select.value = data.current;
    $('vocabItems').replaceChildren(...l.items.map(itemRow));
    $('vocabEmpty').hidden = l.items.length > 0;
    $('vocabCount').textContent = plural(s.total, 'palavra', 'palavras');
    $('vocabImgStatus').textContent = [
      s.ok && `${s.ok} ${s.ok === 1 ? 'imagem pronta' : 'imagens prontas'}`,
      s.loading && `${s.loading} baixando`,
      s.failed.length && `${s.failed.length} ${s.failed.length === 1 ? 'falhou' : 'falharam'}`,
    ].filter(Boolean).join(' · ');
    $('vocabConfigure').disabled = !s.total;

    // sessão
    $('sessionSub').textContent = `${l.name} · ${plural(s.total, 'palavra', 'palavras')}`;
    for (const b of document.querySelectorAll('#vocabSession .mode')) {
      b.setAttribute('aria-pressed', String(b.dataset.mode === settings.vocabMode));
    }
    for (const b of document.querySelectorAll('#vocabSession [data-pace]')) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.pace) === settings.vocabPace));
    }
    const usable = image ? s.ok + s.loading : s.total;
    const total = usable * settings.vocabReps;
    $('repsOut').textContent = `${settings.vocabReps}×`;
    $('repsSummary').textContent =
      `${plural(usable, 'palavra', 'palavras')} × ${settings.vocabReps} = ${total} · cerca de ${formatDuration(total * settings.vocabPace)}`;
    $('vocabShuffle').checked = settings.vocabShuffle;
    $('vocabCaption').checked = settings.vocabCaption;
    $('captionRow').hidden = !image;
    $('precacheCard').hidden = !image;
    $('wordModeNote').hidden = image;
    $('wordModeNote').textContent =
      `Este modo não usa imagens: ${s.total === 1 ? 'a palavra entra' : `as ${s.total} palavras entram`}, inclusive as que não têm imagem.`;
    if (image) {
      $('precacheCount').textContent = `${s.ok} de ${s.withUrl}`;
      $('precacheBar').style.width = s.withUrl ? `${(s.ok / s.withUrl) * 100}%` : '0%';
      const issues = [
        s.loading && `${s.loading} baixando`,
        s.failed.length && `${listNames(s.failed)} ${s.failed.length === 1 ? 'falhou e fica' : 'falharam e ficam'} de fora`,
        s.noUrl && `${plural(s.noUrl, 'sem link fica', 'sem link ficam')} de fora`,
      ].filter(Boolean).join(' · ');
      $('precacheIssues').textContent = issues || 'Todas as imagens estão prontas.';
      $('precacheIssues').classList.toggle('ok', !issues);
      $('precacheRetry').hidden = !s.failed.length;
      $('precachePhone').textContent = phoneSummary;
    }
    $('vocabStart').disabled = !usable;
  }

  let phoneSummary = '';

  // agrupa várias imagens terminando juntas num só render (setTimeout, e não
  // requestAnimationFrame, que fica parado com a página em segundo plano)
  let pending = 0;
  function refresh() {
    if (pending) return;
    pending = setTimeout(() => {
      pending = 0;
      render();
    }, 50);
  }

  updateAddButton();
  render();

  return {
    refresh,
    /** Itens da lista atual. */
    listItems: () => list().items,
    /** Itens da lista atual que entram na sessão, conforme o modo. */
    sessionItems: () => sessionItems(list().items, settings.vocabMode, images),
    /** Estado das imagens no celular conectado ('' sem celular). */
    setPhoneSummary(text) {
      if (text === phoneSummary) return;
      phoneSummary = text;
      refresh();
    },
  };
}
