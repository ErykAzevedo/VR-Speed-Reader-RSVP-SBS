# VR Speed Reader (RSVP + SBS)

Leitor RSVP (uma palavra por vez, no mesmo lugar) em **lado a lado (SBS)** para VR Box, com
**narração em inglês sincronizada palavra por palavra**. Você vê e ouve cada palavra ao mesmo
tempo, sem distrações em volta.

É um web app: roda no navegador do celular (Android ou iPhone), sem instalar nada, sem Unity e sem loja.

**Abrir:** https://erykazevedo.github.io/VR-Speed-Reader-RSVP-SBS/

## Rodar localmente

```bash
python3 -m http.server 8080 --bind 0.0.0.0
```

- No computador: http://localhost:8080
- No celular (mesma rede Wi-Fi): `http://<IP-do-Mac>:8080` — descubra o IP com `ipconfig getifaddr en0`.

### HTTPS (recomendado no celular)

Por HTTP na rede local, a leitura e a voz funcionam, mas o navegador bloqueia duas coisas:
**manter a tela ligada** (Wake Lock) e **sensores de movimento** (gestos de cabeça). Opções:

1. **GitHub Pages** (melhor): publique a pasta num repositório e ative o Pages. Vira um link HTTPS
   fixo, e dá para "Adicionar à tela inicial" como app.
2. **Android, só para testes**: em `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, adicione
   `http://<IP-do-Mac>:8080` e reinicie o Chrome.

## Como usar

1. Cole um texto em inglês ou abra um `.txt`. A posição de leitura fica salva por texto.
2. Escolha a velocidade (comece com 160–220 wpm) e a voz. **Testar voz** diz se a voz informa cada
   palavra (sincronia exata) ou se a sincronia será estimada.
3. **Entrar no VR** → tela cheia, paisagem. Durante a contagem, coloque o celular no VR Box.
4. Se a palavra aparecer dupla, mexa no **ajuste horizontal** (valores positivos aproximam as
   imagens do centro). Ajuste também a altura e o tamanho da fonte.

### Controles dentro do VR

| Ação | Como |
| --- | --- |
| Play / pausa | toque na tela · Espaço/Enter · A/Start · ⏯ · abaixar a cabeça |
| Próxima frase | → · D-pad direita · ⏭ · inclinar a cabeça para a direita |
| Repetir / frase anterior | ← · D-pad esquerda · ⏮ · inclinar a cabeça para a esquerda |
| Mais rápido / devagar | ↑ / ↓ · D-pad · RB / LB |
| Sair | toque longo · Esc · Select · botão Voltar |

O controle Bluetooth que vem com muitos VR Box funciona como teclado, botões de mídia ou gamepad;
os três modos estão mapeados.

## Como funciona

```
texto ──► text.js ──► palavras + frases (chunks de até ~28 palavras)
                         │
                         ▼
              reader.js (motor de leitura)
   com áudio: 1 fala por frase (SpeechSynthesis)
              evento "boundary" ──► mostra a palavra falada agora
              sem "boundary"    ──► estima pelo tamanho das palavras e
                                    ressincroniza no fim de cada frase
   sem áudio: temporizador no WPM escolhido
                         │
                         ▼
              sbs.js ──► mesma palavra nas duas metades da tela,
                         letra de foco (ORP) em vermelho no centro da lente
```

- **A voz comanda a tela**: o texto nunca se adianta nem se atrasa em relação ao áudio.
- **Calibração automática**: o app mede quantas palavras por minuto a voz fala de verdade e ajusta o
  `rate` para chegar ao WPM pedido.
- **Uma fala por frase**: contorna o corte de falas longas do Chrome e permite voltar/avançar por frase.
- **Pausa = cancelar e recomeçar da palavra atual**: o `pause()` nativo é instável no Android.

| Arquivo | Papel |
| --- | --- |
| `js/text.js` | divide palavras e frases, letra de foco (ORP), peso de cada palavra |
| `js/reader.js` | reprodução: TTS sincronizado, modo estimado, modo silencioso, navegação |
| `js/sbs.js` | desenho lado a lado, centralização do foco, redução de palavras longas |
| `js/input.js` | teclado, botões de mídia, gamepad, toque e gestos de cabeça |
| `js/main.js` | tela de configurações, vozes, tela cheia, wake lock, posição salva |

## Próximos passos sugeridos

1. **EPUB e PDF**: importar livros (EPUB é um zip de HTML; dá para ler com JSZip no próprio navegador).
2. **Vozes neurais**: gerar o áudio antes, com um TTS que devolve o tempo de cada palavra (Azure
   Speech, ElevenLabs, Google Cloud TTS), e tocar como arquivo. Voz muito melhor, sincronia exata e
   funciona offline depois de gerado.
3. **Áudiolivro + texto**: alinhar um audiolivro real com o texto (forced alignment, ex.: WhisperX).
4. **Ajuda de vocabulário**: ao pausar, mostrar a tradução da palavra ou da frase atual.
5. **PWA offline**: service worker para abrir sem internet.
6. **Estatísticas**: tempo lido, wpm médio e sequência de dias.
