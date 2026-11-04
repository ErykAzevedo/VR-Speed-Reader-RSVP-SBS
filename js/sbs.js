// Visual lado a lado (SBS): o mesmo conteúdo é desenhado em cada metade da
// tela, uma para cada lente do VR Box. O ajuste horizontal desloca as duas
// imagens em sentidos opostos para alinhar com as lentes (IPD) e para
// definir a "profundidade" em que a palavra parece flutuar.

import { pivotIndex } from './text.js';

const EYE_TEMPLATE = `
  <div class="stage">
    <div class="status"></div>
    <div class="reticle top"></div>
    <div class="word"><span class="w-left"></span><span class="w-pivot"></span><span class="w-right"></span></div>
    <div class="reticle bottom"></div>
    <div class="context"></div>
    <div class="flash"></div>
    <div class="progress"><div class="bar"></div></div>
  </div>`;

export class SbsView {
  constructor(root) {
    this.root = root;
    this.eyes = [...root.querySelectorAll('.eye')];
    for (const eye of this.eyes) eye.innerHTML = EYE_TEMPLATE;
    this.parts = this.eyes.map((eye) => ({
      eye,
      word: eye.querySelector('.word'),
      left: eye.querySelector('.w-left'),
      pivot: eye.querySelector('.w-pivot'),
      right: eye.querySelector('.w-right'),
      context: eye.querySelector('.context'),
      status: eye.querySelector('.status'),
      flash: eye.querySelector('.flash'),
      bar: eye.querySelector('.bar'),
    }));
    this.fit = 1;
    this.flashTimer = null;
  }

  apply({ fontSize, shiftX, shiftY, mono, showContext }) {
    const s = this.root.style;
    s.setProperty('--font', `${fontSize}px`);
    s.setProperty('--shift-x', `${shiftX}px`);
    s.setProperty('--shift-y', `${shiftY}px`);
    this.root.classList.toggle('mono', mono);
    this.root.classList.toggle('show-context', showContext);
  }

  showWord(text) {
    const p = pivotIndex(text);
    const a = text.slice(0, p);
    const b = text.charAt(p);
    const c = text.slice(p + 1);
    for (const part of this.parts) {
      part.left.textContent = a;
      part.pivot.textContent = b;
      part.right.textContent = c;
    }
    this._align();
  }

  /** Centraliza a letra de foco e reduz a fonte se a palavra não couber na lente. */
  _align() {
    const ref = this.parts.find((p) => p.eye.offsetWidth > 0) ?? this.parts[0];
    // medidas no tamanho atual, convertidas para o tamanho "cheio" (fit = 1)
    const natural = ref.word.offsetWidth / this.fit;
    if (!natural) return;
    const center = (ref.left.offsetWidth + ref.pivot.offsetWidth / 2) / this.fit;
    // a letra de foco fica no meio da lente: o lado mais comprido é que precisa caber
    const widestSide = Math.max(center, natural - center);
    this.fit = Math.min(1, (ref.eye.clientWidth * 0.45) / widestSide);
    const s = this.root.style;
    s.setProperty('--fit', this.fit.toFixed(3));
    s.setProperty('--word-x', `${(-center * this.fit).toFixed(1)}px`);
  }

  /** Frase atual com a palavra em destaque (texto puro, sem innerHTML). */
  showContext(words, start, end, current) {
    for (const part of this.parts) {
      const frag = document.createDocumentFragment();
      for (let i = start; i < end; i++) {
        if (i > start) frag.append(' ');
        if (i === current) {
          const mark = document.createElement('mark');
          mark.textContent = words[i].text;
          frag.append(mark);
        } else {
          frag.append(words[i].text);
        }
      }
      part.context.replaceChildren(frag);
    }
  }

  setStatus(text) {
    for (const part of this.parts) part.status.textContent = text;
  }

  setProgress(fraction) {
    for (const part of this.parts) part.bar.style.width = `${(fraction * 100).toFixed(2)}%`;
  }

  setPaused(paused) {
    this.root.classList.toggle('paused', paused);
  }

  /** Ícone rápido de confirmação (ex.: gesto de cabeça reconhecido). */
  flash(symbol) {
    for (const part of this.parts) part.flash.textContent = symbol;
    this.root.classList.add('flashing');
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.root.classList.remove('flashing'), 600);
  }
}
