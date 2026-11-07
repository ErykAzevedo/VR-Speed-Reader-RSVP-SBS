// Armazenamento local e configurações padrão, compartilhados pelo painel e pelo celular.

export const store = {
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

export const DEFAULTS = {
  tab: 'text',
  wpm: 200, chunk: 1, font: 46, context: false,
  audio: true, voiceURI: '',
  mode: 'sbs', shiftX: 0, shiftY: 0, countdown: 5, head: false, headInvert: false,
  vocabMode: 'word', vocabReps: 3, vocabPace: 2, vocabShuffle: true, vocabCaption: true,
};

export const loadSettings = () => ({ ...DEFAULTS, ...store.get('settings', {}) });
