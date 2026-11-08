# VR Speed Reader (RSVP + SBS)

Leitor RSVP (uma palavra por vez, no mesmo lugar) em **lado a lado (SBS)** para VR Box, com
**narração em inglês sincronizada palavra por palavra**. Você vê e ouve cada palavra ao mesmo
tempo, sem distrações em volta.

É um web app: roda no navegador do celular (Android ou iPhone), sem instalar nada, sem Unity e sem loja.

**Painel:** https://erykazevedo.github.io/VR-Speed-Reader-RSVP-SBS/ · **Celular:** `…/vr.html`

## Painel + celular

Configurar com o celular preso no óculos é difícil, então são dois endereços:

| Endereço | Onde abrir | O que faz |
| --- | --- | --- |
| `index.html` (painel) | computador, tablet ou outro celular | texto, listas, todas as configurações e o controle remoto |
| `vr.html` (celular) | o celular que vai no VR Box | só a tela do VR |

1. Abra o **painel**. Ele mostra um **QR code** e um código de 6 dígitos.
2. No celular do VR Box, leia o QR code (ou abra `vr.html` e digite o código).
3. Toque em **Começar** no celular: a tela cheia e a voz só podem ser liberadas com um toque no
   próprio aparelho. Encaixe o celular no VR Box.
4. Configure no painel: fonte, ajuste das lentes, velocidade, voz, palavras por vez… tudo é aplicado
   no celular **na hora**, inclusive com a leitura rodando. A lista de vozes do painel passa a ser a
   do celular.
5. **▶ Iniciar no celular** começa a leitura (ou a sessão de vocabulário). A barra de controle remoto
   embaixo mostra o que está tocando e tem ⏮ ⏯ ⏭, − / + velocidade e ■ parar.

O código fica salvo nos dois aparelhos: da próxima vez basta abrir o painel e o `vr.html` que eles
se reconectam sozinhos. Sem celular pareado, o painel continua abrindo o VR no próprio aparelho.

A conexão é direta entre os dois aparelhos (WebRTC, via [PeerJS](https://peerjs.com)). O servidor
público do PeerJS só apresenta um aparelho ao outro: o texto e os comandos vão criptografados de um
para o outro, sem passar por servidor nosso. Por isso os dois aparelhos precisam de internet para
parear (funciona melhor na mesma rede Wi-Fi).

## Rodar localmente

```bash
python3 .claude/devserver.py 8080
```

(é o `http.server` do Python sem cache, para os módulos sempre virem atualizados)

**Ao publicar mudanças:** troque o `v=` do *import map* e do script principal em `index.html` e
`vr.html`. O GitHub Pages guarda os arquivos em cache por 10 minutos, e sem isso o navegador pode
misturar módulos novos e antigos.

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
   - **Palavras por vez**: com 1, aparece uma palavra com a letra de foco em vermelho. Com 2 a 4,
     aparecem blocos de sentido ("in the same spot," · "while your mind"): quebram na pontuação, não
     terminam em "the", "of", "your"… e a palavra que a voz está falando fica sublinhada. O tamanho
     dos blocos também respeita a largura da lente; com fonte menor cabem blocos maiores.
3. **Entrar no VR** → tela cheia, paisagem. Durante a contagem, coloque o celular no VR Box.
4. Se a palavra aparecer dupla, mexa no **ajuste horizontal** (valores positivos aproximam as
   imagens do centro). Ajuste também a altura e o tamanho da fonte.

### Vocabulário com imagens

Na aba **Vocabulário**, cole uma palavra por linha no formato `palavra, link da imagem` (também
aceita `;` ou tab, e linha só com a palavra) ou abra um `.csv`. Dá para ter várias listas.

- As imagens começam a baixar assim que entram na lista. Cada palavra mostra se a imagem está
  pronta, baixando ou com falha. Toque na palavra para trocar o link.
- **Configurar sessão** → escolha o modo, o número de **repetições** da lista, o **tempo por
  palavra** e se a ordem é embaralhada a cada volta.
  - **Palavra em RSVP**: ouve e vê a palavra no centro da lente. Usa todas as palavras.
  - **Imagem pré-carregada**: ouve a palavra e vê a imagem (com a palavra embaixo, opcional). Só
    entram as palavras cuja imagem carregou; ao entrar no VR o app espera as que ainda estão baixando.
- Cada palavra fica na tela pelo tempo escolhido, ou até a voz terminar de falar, o que for mais longo.

**Cache das imagens:** se o site da imagem permite (CORS), ela é guardada no aparelho e funciona
offline nas próximas vezes. Se não permite, ela é carregada direto e fica na memória enquanto o app
está aberto. Em ambos os casos ela já está carregada quando a palavra aparece.

#### Hospedar suas imagens (pasta `images/`)

As imagens podem ficar no próprio repositório: o GitHub Pages publica a pasta `images/` no mesmo
endereço do app, então o cache offline sempre funciona (mesma origem, sem CORS).

1. Coloque as imagens em `images/entrada/` com **o nome da palavra**: `cat.jpg`, `maçã.heic`,
   `ice_cream.png` (o `_` vira espaço). Essa pasta não vai para o Git.
2. Rode:

   ```bash
   python3 scripts/add-images.py
   ```

   Cada imagem é reduzida para no máximo 1024 px, convertida para JPEG (PNG continua PNG, GIF/WebP
   vão como estão), **perde os metadados** (EXIF com GPS, câmera, data: o repositório é público) e
   é salva em `images/` com nome sem acento. A lista `images/vocabulario.csv` é atualizada.
3. Faça commit e push de `images/`. Em alguns minutos os links funcionam; cole o conteúdo de
   `images/vocabulario.csv` (ou abra o arquivo) na aba **Vocabulário**.

Trocar a imagem de uma palavra é só rodar de novo com o mesmo nome. O script usa o `sips` do macOS,
sem instalar nada.

### Controles dentro do VR

| Ação | Como |
| --- | --- |
| Play / pausa | toque na tela · Espaço/Enter · A/Start · ⏯ · abaixar a cabeça |
| Avançar (frase / palavra) | → · D-pad direita · ⏭ · inclinar a cabeça para a direita |
| Voltar (frase / palavra) | ← · D-pad esquerda · ⏮ · inclinar a cabeça para a esquerda |
| Mais rápido / devagar | ↑ / ↓ · D-pad · RB / LB (no vocabulário muda o tempo por palavra) |
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
| `js/text.js` | divide palavras e frases, blocos de sentido (chunking), letra de foco (ORP), peso de cada palavra |
| `js/reader.js` | reprodução: TTS sincronizado, modo estimado, modo silencioso, navegação |
| `js/sbs.js` | desenho lado a lado, centralização do foco, redução de palavras longas, imagem e voltas |
| `js/input.js` | teclado, botões de mídia, gamepad, toque e gestos de cabeça |
| `js/vocab.js` | lista `palavra, link`, cache das imagens, player com repetições |
| `js/vocab-ui.js` | aba Vocabulário: listas, estado das imagens, configuração da sessão |
| `js/engine.js` | o VR em si: tela cheia, wake lock, sessões de texto e vocabulário, status |
| `js/link.js` | pareamento painel ↔ celular (PeerJS) com reconexão automática |
| `js/store.js` | armazenamento local e configurações padrão |
| `js/main.js` | painel: abas, configurações, vozes, QR code, controle remoto |
| `js/vr.js` | celular: aplica o que chega do painel e devolve o status |

## Próximos passos sugeridos

1. **EPUB e PDF**: importar livros (EPUB é um zip de HTML; dá para ler com JSZip no próprio navegador).
2. **Vozes neurais**: gerar o áudio antes, com um TTS que devolve o tempo de cada palavra (Azure
   Speech, ElevenLabs, Google Cloud TTS), e tocar como arquivo. Voz muito melhor, sincronia exata e
   funciona offline depois de gerado.
3. **Áudiolivro + texto**: alinhar um audiolivro real com o texto (forced alignment, ex.: WhisperX).
4. **Tradução**: ao pausar, mostrar a tradução da palavra ou da frase atual; no vocabulário, uma
   terceira coluna opcional `palavra, link, tradução`.
5. **PWA offline**: service worker para abrir sem internet.
6. **Estatísticas**: tempo lido, wpm médio e sequência de dias.
