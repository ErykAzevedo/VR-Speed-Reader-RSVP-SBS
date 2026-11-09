#!/usr/bin/env python3
"""Cria as imagens de chunks, palavras e frases com a API do Gemini, sempre no mesmo padrão neon.

A fonte da verdade é images/items.json. Cada item tem:
  id           criado uma vez e congelado (c-, w-, s- + slug). Editar o texto não muda o id nem a imagem.
  type         chunk | word | sentence
  text, sense  o texto; em palavras, o sentido ("bank" + "financial institution" ≠ "bank" + "river side")
  meaning_pt   tradução
  scene        a cena desenhada. O estilo é fixo e é anexado pelo script, não fica aqui.
  tags         com namespace: topic:travel, function:greeting, level:a2, source:callan-stage-4
  uses         ids de chunks/palavras que uma frase exercita
  image, prompt_hash, image_model   o arquivo, o hash do prompt que o gerou e o modelo usado

Fluxo (duas etapas, para revisar a cena antes de pagar pela imagem):
    python3 scripts/generate-images.py adicionar "Nice to meet you." "It's up to you." --tags function:greeting
    python3 scripts/generate-images.py adicionar --tipo word "bank" --sentido "financial institution"
    python3 scripts/generate-images.py adicionar --tipo sentence --arquivo frases.txt --usa c-take-your-time
        → o Gemini escreve a cena e a tradução; revise (ou edite) em images/items.json
    python3 scripts/generate-images.py gerar
        → gera o que falta: item sem imagem, ou cuja cena mudou desde a última imagem (prompt_hash)
    python3 scripts/generate-images.py gerar --dry-run       # mostra o que geraria, sem custo
    python3 scripts/generate-images.py gerar c-see-you-later --forcar   # outra imagem, mesma cena
    python3 scripts/generate-images.py cena c-see-you-later --nova      # pede outra cena ao Gemini
    python3 scripts/generate-images.py cena c-see-you-later --texto "Two figures ..."
    (adicionar --gerar faz as duas etapas de uma vez)

Onde as imagens ficam (endereços já publicados não mudam):
    chunk → images/<slug>.jpg            lista images/chunks.csv
    word → images/words/<slug>.jpg       lista images/palavras.csv
    sentence → images/sentences/<slug>.jpg  lista images/frases.csv

Requer GEMINI_API_KEY. Modelos: GEMINI_IMAGE_MODEL e GEMINI_TEXT_MODEL trocam os padrões.
Só usa a biblioteca padrão do Python e o sips do macOS (via add-images.py).
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IMAGES = ROOT / 'images'
ITEMS = IMAGES / 'items.json'
API = 'https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent'
# o mesmo modelo das imagens atuais: trocar de modelo muda o traço e quebra o padrão
IMAGE_MODEL = os.environ.get('GEMINI_IMAGE_MODEL', 'gemini-2.5-flash-image')
TEXT_MODEL = os.environ.get('GEMINI_TEXT_MODEL', 'gemini-flash-latest')
STYLE_REFS = ['how-are-you-doing.jpg', 'hows-it-going.jpg']

TYPES = {
    'chunk': {'prefix': 'c', 'dir': '', 'csv': 'chunks.csv'},
    'word': {'prefix': 'w', 'dir': 'words', 'csv': 'palavras.csv'},
    'sentence': {'prefix': 's', 'dir': 'sentences', 'csv': 'frases.csv'},
}
TYPE_ALIASES = {'palavra': 'word', 'frase': 'sentence'}

# Tags: famílias abertas e fechadas. Nas fechadas, um valor novo entra editando esta lista,
# para não surgir "farewell" e "goodbye" querendo dizer a mesma coisa.
TAG_OPEN = {'topic', 'source'}
TAG_CLOSED = {
    'level': {'a1', 'a2', 'b1', 'b2', 'c1', 'c2'},
    'function': {
        'greeting', 'farewell', 'request', 'offer', 'opinion', 'agreement', 'disagreement',
        'uncertainty', 'reassurance', 'apology', 'thanks', 'transition', 'understanding', 'waiting',
    },
}

# ---------- prompt da imagem (igual ao generate.py original) ----------

STYLE = (
    'Neon line art on a pure black background. Simple glowing outline figures, no facial detail '
    'beyond a basic profile, thin luminous strokes with soft glow. Main speaker in cyan, the other '
    'person in magenta, objects in yellow or green accents. Minimal, centered composition, lots of '
    'negative space. No text, no letters, no words, no numbers anywhere in the image. Square 1:1.'
)
REF_NOTE = (
    'The attached images are STYLE REFERENCES ONLY: copy their line style, neon glow, color palette '
    'and black background. Do NOT copy their composition, poses or objects. Draw this new scene:\n\n'
)

# ---------- instrução da cena, uma por tipo ----------

SCENE_COMMON = """You write scene descriptions for flashcard illustrations that help a Brazilian
learner memorize English. An image generator will draw your scene in a fixed neon line-art style
that is added separately, so never describe the art style, colors of the background or lighting.

Rules:
- 1 to 3 short sentences, concrete and drawable.
- At most two figures: "a cyan figure" is the speaker, "a magenta figure" is the other person.
  Objects are glowing yellow or green. Keep it minimal: one idea, lots of empty space.
- State poses, gestures and directions explicitly (who faces whom, who moves where).
- Never ask for text, letters, numbers, signs, labels or speech bubbles with words.
"""

SCENE_BY_TYPE = {
    'chunk': """- Show the MEANING of the chunk through a typical situation or a visual metaphor,
  NEVER the literal words. If a literal reading would mislead the image generator (for example
  "make up your mind" → makeup), end the scene with an explicit prohibition such as
  "No cosmetics or makeup."
- Do not reuse the central object of an existing scene (listed below) unless it is essential:
  similar images make chunks hard to tell apart.""",
    'word': """- Show the word ONLY in this sense: {sense}. If the word has other common senses, make
  sure the image cannot be read as them, and add an explicit prohibition if needed.
- One isolated object, or one figure doing one action, centered. Concrete nouns: just the object.
  Verbs: one figure clearly doing the action.
- The fixed style mentions figures, so when the scene has no figure, end it with
  "No people or figures." to keep the image generator from adding them.""",
    'sentence': """- Show the sentence LITERALLY, as one clear scene (who, what, where), so a listener can
  match it to the audio before reading the text. No metaphors.
- Include every concrete detail the sentence mentions (objects, place, how many), so that a
  similar sentence with one different detail would get a visibly different image.""",
}

SCENE_TAIL = """
{examples}
{kind}: {text}{sense_line}"""

SCENE_SCHEMA = {
    'type': 'OBJECT',
    'properties': {
        'scene': {'type': 'STRING'},
        'meaning_pt': {'type': 'STRING', 'description': 'tradução natural em português do Brasil'},
    },
    'required': ['scene', 'meaning_pt'],
}


def load_add_images():
    spec = importlib.util.spec_from_file_location('add_images', ROOT / 'scripts' / 'add-images.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


AI = load_add_images()


# ---------- items.json ----------

def load_items() -> list[dict]:
    return json.loads(ITEMS.read_text(encoding='utf-8')) if ITEMS.exists() else []


def save_items(items: list[dict]) -> None:
    ITEMS.write_text(json.dumps(items, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def full_prompt(scene: str) -> str:
    return f'{REF_NOTE}{scene} {STYLE}'


def prompt_hash(scene: str) -> str:
    return hashlib.sha256(full_prompt(scene).encode()).hexdigest()[:12]


def new_id(type_: str, text: str, sense: str, taken: set[str]) -> str:
    # "What's" → "whats", como nas imagens atuais (whats-going-on, im-not-sure)
    text = re.sub(r"['’]", '', text)
    words = AI.slug(text).split('-')[:5]
    if sense:
        words += AI.slug(sense).split('-')[:1]
    base = f'{TYPES[type_]["prefix"]}-' + '-'.join(w for w in words if w)
    out, n = base, 2
    while out in taken:
        out, n = f'{base}-{n}', n + 1
    return out


def check_tags(tags: list[str]) -> list[str]:
    out = []
    for t in tags:
        t = t.strip().lower()
        if not t:
            continue
        ns, sep, value = t.partition(':')
        if not sep or not value:
            raise SystemExit(f'tag sem família: "{t}" (use topic:, function:, level: ou source:)')
        if ns in TAG_CLOSED and value not in TAG_CLOSED[ns]:
            raise SystemExit(f'tag "{t}" fora da lista fechada de {ns}: {", ".join(sorted(TAG_CLOSED[ns]))}'
                             '\n(para um valor novo, edite TAG_CLOSED no script)')
        if ns not in TAG_CLOSED and ns not in TAG_OPEN:
            raise SystemExit(f'família de tag desconhecida: "{ns}"')
        out.append(t)
    return out


# ---------- API ----------

def call(model: str, api_key: str, body: dict) -> dict:
    req = urllib.request.Request(
        API.format(model),
        data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', 'x-goog-api-key': api_key},
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 503) and attempt < 2:
                time.sleep(10 * (attempt + 1))
                continue
            raise RuntimeError(f'HTTP {e.code} em {model}: {e.read().decode()[:300]}') from None
    raise AssertionError


def parts_of(data: dict) -> list[dict]:
    return [p for c in data.get('candidates', []) for p in c.get('content', {}).get('parts', [])]


def write_scene(api_key: str, item: dict, items: list[dict]) -> dict:
    t = item['type']
    same = [i for i in items if i['type'] == t and i.get('scene') and i['id'] != item['id']]
    examples = ''
    if same:
        examples = 'Existing scenes of this kind (match their level of detail):\n' + '\n'.join(
            f'- "{i["text"]}" → {i["scene"]}' for i in same[-20:])
    brief = SCENE_COMMON + SCENE_BY_TYPE[t].format(sense=item.get('sense') or 'its most common sense')
    brief += SCENE_TAIL.format(
        examples=examples, kind=t.capitalize(), text=item['text'],
        sense_line=f'\nSense: {item["sense"]}' if item.get('sense') else '')
    data = call(TEXT_MODEL, api_key, {
        'contents': [{'parts': [{'text': brief}]}],
        'generationConfig': {'responseMimeType': 'application/json', 'responseSchema': SCENE_SCHEMA},
    })
    text = ''.join(p.get('text', '') for p in parts_of(data))
    try:
        out = json.loads(text)
        return {'scene': out['scene'].strip(), 'meaning_pt': out['meaning_pt'].strip()}
    except (ValueError, KeyError):
        raise RuntimeError(f'cena inválida: {text[:300] or json.dumps(data)[:300]}') from None


def draw(api_key: str, refs: list[dict], scene: str) -> bytes:
    data = call(IMAGE_MODEL, api_key, {
        'contents': [{'parts': refs + [{'text': full_prompt(scene)}]}],
        'generationConfig': {'responseModalities': ['IMAGE'], 'imageConfig': {'aspectRatio': '1:1'}},
    })
    for p in parts_of(data):
        inline = p.get('inlineData') or p.get('inline_data')
        if inline and inline.get('data'):
            return base64.b64decode(inline['data'])
    raise RuntimeError(f'resposta sem imagem: {json.dumps(data)[:300]}')


def need_key() -> str:
    key = os.environ.get('GEMINI_API_KEY')
    if not key:
        raise SystemExit('GEMINI_API_KEY não definida (rode: source ~/.zshrc)')
    return key


# ---------- lista .csv do app ----------

def upsert_csv(item: dict) -> Path:
    csv = IMAGES / TYPES[item['type']]['csv']
    rows = AI.read_list(csv)
    rel = Path(item['image']).relative_to('images').as_posix()
    url = AI.BASE_URL + rel
    stem = Path(rel).stem
    at = next((j for j, (_, u) in enumerate(rows) if u.rsplit('/', 1)[-1].rsplit('.', 1)[0] == stem), None)
    if at is None:
        rows.append((item['text'], url))
    else:
        rows[at] = (item['text'], url)
    AI.write_list(csv, rows)
    return csv


# ---------- comandos ----------

def cmd_adicionar(args) -> int:
    type_ = TYPE_ALIASES.get(args.tipo, args.tipo)
    texts = list(args.textos)
    if args.arquivo:
        texts += [l.strip() for l in args.arquivo.read_text(encoding='utf-8').splitlines()
                  if l.strip() and not l.lstrip().startswith('#')]
    if not texts:
        raise SystemExit('passe ao menos um texto (ou --arquivo)')
    if args.sentido and len(texts) > 1:
        raise SystemExit('--sentido vale para uma palavra por vez')
    tags = check_tags(args.tags.split(',') if args.tags else [])
    items = load_items()
    ids = {i['id'] for i in items}
    for u in args.usa or []:
        if u not in ids:
            raise SystemExit(f'--usa: id não encontrado: {u}')

    new = []
    for text in texts:
        sense = args.sentido or ''
        dup = next((i for i in items if i['type'] == type_ and i['text'].lower() == text.lower()
                    and (i.get('sense') or '').lower() == sense.lower()), None)
        if dup:
            print(f'  · {text}: já existe como {dup["id"]}, pulei')
            continue
        item = {
            'id': new_id(type_, text, sense, ids), 'type': type_, 'text': text, 'sense': sense,
            'meaning_pt': '', 'scene': args.cena or '', 'tags': tags, 'uses': args.usa or [],
            'image': None, 'prompt_hash': None, 'image_model': None,
        }
        ids.add(item['id'])
        new.append(item)

    print(f'texto: {TEXT_MODEL} | {len(new)} item(ns) novo(s)')
    if args.dry_run:
        for i in new:
            print(f'  - {i["id"]}  ({i["text"]})')
        return 0
    if not new:
        return 0

    key = need_key() if any(not i['scene'] for i in new) else None
    failed = []
    for i in new:
        print(f'+ {i["id"]}  {i["text"]}')
        if not i['scene']:
            try:
                i.update(write_scene(key, i, items))
            except Exception as e:  # noqa: BLE001
                print(f'    ✗ {e}')
                failed.append(i['text'])
                continue
        items.append(i)
        save_items(items)
        print(f'    cena: {i["scene"]}')
        if i['meaning_pt']:
            print(f'    pt:   {i["meaning_pt"]}')

    if failed:
        print('falharam:', ', '.join(failed))
    added = [i['id'] for i in new if i in items]
    if args.gerar and added:
        print()
        return cmd_gerar(argparse.Namespace(ids=added, forcar=False, dry_run=False)) or (1 if failed else 0)
    if added:
        print(f'\nRevise as cenas em {ITEMS.relative_to(ROOT)} e rode: python3 scripts/generate-images.py gerar')
    return 1 if failed else 0


def cmd_cena(args) -> int:
    items = load_items()
    item = next((i for i in items if i['id'] == args.id), None)
    if not item:
        raise SystemExit(f'id não encontrado: {args.id}')
    if args.texto:
        item['scene'] = args.texto.strip()
    else:
        item.update(write_scene(need_key(), item, items))
    save_items(items)
    print(f'{item["id"]}\n    cena: {item["scene"]}\n    pt:   {item["meaning_pt"]}')
    print('\nA imagem só muda ao rodar: python3 scripts/generate-images.py gerar')
    return 0


def cmd_gerar(args) -> int:
    items = load_items()
    pool = items
    if args.ids:
        known = {i['id'] for i in items}
        missing = [x for x in args.ids if x not in known]
        if missing:
            raise SystemExit(f'id não encontrado: {", ".join(missing)}')
        pool = [i for i in items if i['id'] in args.ids]

    todo, no_scene = [], []
    for i in pool:
        exists = bool(i.get('image')) and (ROOT / i['image']).exists()
        if not i.get('scene'):
            if not exists:
                no_scene.append(i['id'])
            continue  # imagem feita antes do script, sem cena registrada: fica como está
        if args.forcar:
            todo.append((i, 'forçada'))
        elif not exists:
            todo.append((i, 'sem imagem'))
        elif i.get('prompt_hash') != prompt_hash(i['scene']):
            todo.append((i, 'cena mudou'))

    print(f'imagem: {IMAGE_MODEL} | {len(todo)} para gerar, {len(pool) - len(todo)} em dia')
    for x in no_scene:
        print(f'  · {x}: sem cena (rode: cena {x} --nova)')
    if args.dry_run or not todo:
        for i, why in todo:
            print(f'  - {i["id"]}  ({why})')
        return 0

    key = need_key()
    if sys.platform != 'darwin':
        raise SystemExit('O add-images.py usa o "sips", que só existe no macOS.')
    refs = [{'inlineData': {'mimeType': 'image/jpeg', 'data': base64.b64encode(p.read_bytes()).decode()}}
            for p in (IMAGES / r for r in STYLE_REFS) if p.exists()]
    if not refs:
        print('aviso: nenhuma imagem de referência encontrada, o estilo vai variar mais')

    failed = []
    with tempfile.TemporaryDirectory() as tmp:
        for n, (i, why) in enumerate(todo, 1):
            print(f'[{n}/{len(todo)}] {i["id"]}  ({why})')
            dest = IMAGES / TYPES[i['type']]['dir']
            dest.mkdir(parents=True, exist_ok=True)
            # o nome do arquivo sai do id (congelado), não do texto
            stem = Path(i['image']).stem if i.get('image') else i['id'].split('-', 1)[1]
            png = Path(tmp) / f'{stem}.png'
            try:
                png.write_bytes(draw(key, refs, i['scene']))
                _, filename = AI.process(png, dest)
            except Exception as e:  # noqa: BLE001
                print(f'    ✗ {e}')
                failed.append(i['id'])
                continue
            i['image'] = (dest / filename).relative_to(ROOT).as_posix()
            i['prompt_hash'] = prompt_hash(i['scene'])
            i['image_model'] = IMAGE_MODEL
            save_items(items)  # salva a cada imagem: o que já foi pago não se perde
            csv = upsert_csv(i)

    if todo and len(failed) < len(todo):
        print(f'\nListas atualizadas em {IMAGES.relative_to(ROOT)}/ ({csv.name} etc.)')
    if failed:
        print('falharam:', ', '.join(failed))
        return 1
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)

    a = sub.add_parser('adicionar', help='cria itens e pede a cena ao Gemini (sem gerar imagem)')
    a.add_argument('textos', nargs='*')
    a.add_argument('--tipo', default='chunk', choices=[*TYPES, *TYPE_ALIASES])
    a.add_argument('--sentido', help='palavras: o sentido desejado ("financial institution")')
    a.add_argument('--tags', help='separadas por vírgula: function:greeting,level:a2')
    a.add_argument('--usa', nargs='+', help='frases: ids dos chunks/palavras que ela exercita')
    a.add_argument('--cena', help='usa esta cena em vez de pedir ao Gemini')
    a.add_argument('--arquivo', type=Path, help='.txt com um texto por linha')
    a.add_argument('--gerar', action='store_true', help='gera a imagem logo em seguida, sem revisão')
    a.add_argument('--dry-run', action='store_true')
    a.set_defaults(fn=cmd_adicionar)

    g = sub.add_parser('gerar', help='gera as imagens que faltam ou cuja cena mudou')
    g.add_argument('ids', nargs='*')
    g.add_argument('--forcar', action='store_true', help='gera de novo mesmo sem mudança na cena')
    g.add_argument('--dry-run', action='store_true')
    g.set_defaults(fn=cmd_gerar)

    c = sub.add_parser('cena', help='reescreve a cena de um item')
    c.add_argument('id')
    grp = c.add_mutually_exclusive_group(required=True)
    grp.add_argument('--nova', action='store_true', help='pede outra cena ao Gemini')
    grp.add_argument('--texto', help='usa esta cena')
    c.set_defaults(fn=cmd_cena)

    args = ap.parse_args()
    return args.fn(args)


if __name__ == '__main__':
    sys.exit(main())
