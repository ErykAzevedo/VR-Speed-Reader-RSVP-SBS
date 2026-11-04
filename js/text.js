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
