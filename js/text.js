// Parser de texto: divide em palavras e em "chunks" (frases curtas) que
// viram uma fala cada. Frases curtas evitam o corte de falas longas do
// Chrome e permitem voltar/avançar por frase.

const MAX_CHUNK_WORDS = 28;
const SENTENCE_END = /[.!?…]["'”’)\]]*$/;
const SOFT_BREAK = /[,;:—–]["'”’)\]]*$/;
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'e.g', 'i.e',
  'no', 'fig', 'mt', 'u.s', 'u.k', 'approx', 'dept', 'inc', 'ltd', 'co',
]);

function isAbbreviation(token) {
  const core = token.replace(/^[^\p{L}]+/u, '').replace(/\.$/, '').toLowerCase();
  // iniciais ("J.") também não encerram frase
  return ABBREVIATIONS.has(core) || /^\p{L}$/u.test(core);
}

/**
 * @returns {{ words: {text: string, chunk: number}[],
 *             chunks: {start: number, end: number, paraEnd: boolean}[],
 *             avgWeight: number }}
 */
export function parseText(raw) {
  const words = [];
  const chunks = [];
  const paragraphs = raw.replace(/\r\n?/g, '\n').split(/\n\s*\n+/);

  for (const para of paragraphs) {
    const tokens = para.split(/\s+/).filter(Boolean);
    let start = words.length;
    tokens.forEach((token, i) => {
      words.push({ text: token, chunk: chunks.length });
      const count = words.length - start;
      const last = i === tokens.length - 1;
      const endsSentence = SENTENCE_END.test(token) && !isAbbreviation(token);
      const softBreak = count >= MAX_CHUNK_WORDS * 0.6 && SOFT_BREAK.test(token);
      if (last || endsSentence || softBreak || count >= MAX_CHUNK_WORDS) {
        chunks.push({ start, end: words.length, paraEnd: last });
        start = words.length;
      }
    });
  }

  const total = words.reduce((sum, w) => sum + wordWeight(w.text), 0);
  return { words, chunks, avgWeight: words.length ? total / words.length : 1 };
}

// Palavras que "puxam" a seguinte: um grupo não deve terminar nelas.
const LEADING_WORDS = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'into', 'onto',
  'about', 'as', 'like', 'over', 'under', 'after', 'before', 'through', 'between', 'without',
  'and', 'or', 'but', 'nor', 'so', 'if', 'because', 'than', 'that', 'this', 'these', 'those',
  'my', 'your', 'his', 'her', 'its', 'our', 'their', 'i', 'we', 'you', 'he', 'she', 'they', 'it',
  'is', 'are', 'was', 'were', 'be', 'been', 'am', 'will', 'would', 'can', 'could', 'should',
  'must', 'may', 'might', 'do', 'does', 'did', 'has', 'have', 'had', 'not', 'very',
  'when', 'while', 'where', 'which', 'who', 'whose', 'whom', 'what', 'how', 'why', 'until',
  'since', 'although', 'though', 'unless', 'whether', 'each', 'every', 'some', 'any', 'no',
  'all', 'both', 'few', 'many', 'more', 'most', 'such',
]);
const GROUP_BREAK = /[,;:—–.!?…]["'”’)\]]*$/;

const isLeadingWord = (token) => LEADING_WORDS.has(token.toLowerCase().replace(/[^\p{L}']/gu, ''));

/**
 * Agrupa as palavras em blocos de sentido (chunking) para exibir de `maxWords`
 * em `maxWords`, sem passar de `maxChars` nem atravessar a frase. Quebra
 * depois de pontuação e evita terminar o bloco em artigo/preposição.
 * Grava `doc.groups` ({start, end}) e `word.group` em cada palavra.
 */
export function buildGroups(doc, maxWords, maxChars = Infinity) {
  const { words, chunks } = doc;
  const groups = [];
  for (const { start, end: stop } of chunks) {
    let g = start;
    // o bloco [g, e) termina numa palavra que puxa a seguinte (e ainda há seguinte)?
    const dangles = (e) => e < stop && !GROUP_BREAK.test(words[e - 1].text) && isLeadingWord(words[e - 1].text);
    while (g < stop) {
      let end = g;
      let chars = 0;
      while (end < stop) {
        const len = words[end].text.length + (end > g ? 1 : 0);
        if (end > g && (end - g >= maxWords || chars + len > maxChars)) break;
        chars += len;
        end++;
        if (GROUP_BREAK.test(words[end - 1].text)) break;
      }

      // Não termina em "the", "in", "your"…: ou devolve essas palavras para o
      // próximo bloco ("can rest | while your mind"), ou puxa a palavra seguinte
      // quando recuar deixaria uma palavra solta ("to your VR").
      if (dangles(end)) {
        let back = end;
        while (back - g > 1 && dangles(back)) back--;
        let fwd = end;
        let fwdChars = chars;
        while (fwd - g <= maxWords && dangles(fwd)) {
          const len = words[fwd].text.length + 1;
          if (fwdChars + len > maxChars) break;
          fwdChars += len;
          fwd++;
        }
        const backOk = !dangles(back);
        const fwdOk = !dangles(fwd);
        if (backOk && (back - g > 1 || !fwdOk)) end = back;
        else if (fwdOk) end = fwd;
      }

      for (let i = g; i < end; i++) words[i].group = groups.length;
      groups.push({ start: g, end });
      g = end;
    }
  }
  doc.groups = groups;
  return groups;
}

/** Índice da letra de foco (ORP), ignorando pontuação nas pontas. */
export function pivotIndex(word) {
  const lead = word.match(/^[^\p{L}\p{N}]*/u)[0].length;
  const core = word.slice(lead).replace(/[^\p{L}\p{N}]+$/u, '');
  const n = core.length;
  const p = n <= 1 ? 0 : n <= 5 ? 1 : n <= 9 ? 2 : n <= 13 ? 3 : 4;
  return Math.max(0, Math.min(lead + p, word.length - 1));
}

/** Peso relativo de exibição: palavras longas e pontuação ficam mais tempo. */
export function wordWeight(word) {
  const letters = word.replace(/[^\p{L}\p{N}]/gu, '').length;
  let w = 1 + Math.max(0, letters - 6) * 0.1;
  if (SENTENCE_END.test(word)) w += 1.0;
  else if (SOFT_BREAK.test(word)) w += 0.6;
  return w;
}

/** Hash rápido para reconhecer se o texto salvo é o mesmo (e retomar a posição). */
export function textHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return `${str.length}:${h >>> 0}`;
}
