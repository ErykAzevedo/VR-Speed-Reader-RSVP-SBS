#!/usr/bin/env python3
"""Prepara imagens para o vocabulário e as coloca em images/ (publicada pelo GitHub Pages).

Uso:
    python3 scripts/add-images.py                 # processa images/entrada/
    python3 scripts/add-images.py ~/Desktop/fotos # ou qualquer pasta / arquivos

O nome do arquivo vira a palavra: "guarda-chuva.jpg" → "guarda-chuva", "ice_cream.png" → "ice cream".
Para cada imagem:
  - reduz para no máximo MAX_SIDE px no lado maior (fica leve no celular);
  - converte JPG/HEIC/TIFF/BMP para JPEG; PNG também, a não ser que tenha transparência;
  - remove metadados (EXIF com GPS, data, câmera…), porque o repositório é público;
  - salva como images/<nome-sem-acento>.<ext>;
  - atualiza images/vocabulario.csv ("palavra, link"), pronto para colar na aba Vocabulário.
    Se a imagem já está na lista, o texto da palavra fica como está: dá para editar o .csv
    (ex.: "how-are-you-doing" → "How are you doing?") e rodar de novo sem perder a edição.
    Com --lista chunks, a lista vira images/chunks.csv.

Só usa o que já vem no macOS (sips) e a biblioteca padrão do Python.
"""

from __future__ import annotations

import argparse
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IMAGES = ROOT / 'images'
INBOX = IMAGES / 'entrada'
BASE_URL = 'https://erykazevedo.github.io/VR-Speed-Reader-RSVP-SBS/images/'
MAX_SIDE = 1024
JPEG_QUALITY = 80

TO_JPEG = {'.jpg', '.jpeg', '.heic', '.heif', '.tif', '.tiff', '.bmp'}
TO_PNG = {'.png'}
AS_IS = {'.gif', '.webp', '.svg', '.avif'}  # animação / formatos que o sips não regrava bem
KNOWN = TO_JPEG | TO_PNG | AS_IS
OUTPUT_EXTS = {'.jpg', '.png'} | AS_IS


def word_from(path: Path) -> str:
    return unicodedata.normalize('NFC', path.stem).replace('_', ' ').strip()


def slug(word: str) -> str:
    ascii_ = unicodedata.normalize('NFKD', word).encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-z0-9]+', '-', ascii_.lower()).strip('-')


def pixel_size(path: Path) -> tuple[int, int]:
    out = subprocess.run(
        ['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', str(path)],
        capture_output=True, text=True, check=True,
    ).stdout
    w = int(re.search(r'pixelWidth:\s*(\d+)', out).group(1))
    h = int(re.search(r'pixelHeight:\s*(\d+)', out).group(1))
    return w, h


def has_alpha(path: Path) -> bool:
    out = subprocess.run(['sips', '-g', 'hasAlpha', str(path)], capture_output=True, text=True).stdout
    return 'hasAlpha: yes' in out


def convert(src: Path, dst: Path, fmt: str) -> None:
    cmd = ['sips', '-s', 'format', fmt]
    if fmt == 'jpeg':
        cmd += ['-s', 'formatOptions', str(JPEG_QUALITY)]
    if max(pixel_size(src)) > MAX_SIDE:
        cmd += ['-Z', str(MAX_SIDE)]
    cmd += [str(src), '--out', str(dst)]
    subprocess.run(cmd, capture_output=True, text=True, check=True)


def strip_jpeg(data: bytes) -> bytes:
    """Tira os segmentos APP1..APP15 e COM (EXIF, XMP, comentários). Mantém APP0 (JFIF)."""
    if data[:2] != b'\xff\xd8':
        return data
    out, i = bytearray(data[:2]), 2
    while i + 4 <= len(data) and data[i] == 0xFF:
        marker = data[i + 1]
        if marker == 0xDA:  # início da imagem comprimida: o resto vai inteiro
            break
        length = struct.unpack('>H', data[i + 2:i + 4])[0]
        if not (0xE1 <= marker <= 0xEF or marker == 0xFE):
            out += data[i:i + 2 + length]
        i += 2 + length
    return bytes(out + data[i:])


def strip_png(data: bytes) -> bytes:
    """Tira os blocos de texto e EXIF do PNG."""
    sig = b'\x89PNG\r\n\x1a\n'
    if not data.startswith(sig):
        return data
    drop = {b'eXIf', b'tEXt', b'iTXt', b'zTXt', b'tIME'}
    out, i = bytearray(sig), len(sig)
    while i + 8 <= len(data):
        length = struct.unpack('>I', data[i:i + 4])[0]
        kind = data[i + 4:i + 8]
        end = i + 12 + length
        if kind not in drop:
            out += data[i:end]
        i = end
    return bytes(out)


def process(src: Path, dest_dir: Path) -> tuple[str, str] | None:
    ext = src.suffix.lower()
    word = word_from(src)
    name = slug(word)
    if not name:
        print(f'  ✗ {src.name}: nome sem letras ou números, pulei')
        return None

    if ext in TO_PNG:
        out_ext = '.png' if has_alpha(src) else '.jpg'  # JPEG fica bem menor
    else:
        out_ext = '.jpg' if ext in TO_JPEG else ext
    dst = dest_dir / f'{name}{out_ext}'
    # a mesma palavra com outra extensão (ex.: trocou foto.png por foto.jpg) sai
    for old in dest_dir.glob(f'{name}.*'):
        if old.suffix.lower() in OUTPUT_EXTS and old != dst:
            old.unlink()

    if ext in AS_IS:
        shutil.copyfile(src, dst)
    else:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_out = Path(tmp) / dst.name
            convert(src, tmp_out, 'jpeg' if out_ext == '.jpg' else 'png')
            data = tmp_out.read_bytes()
        dst.write_bytes(strip_jpeg(data) if out_ext == '.jpg' else strip_png(data))

    kb = dst.stat().st_size / 1024
    note = '  ⚠ arquivo grande, considere reduzir' if kb > 1024 else ''
    print(f'  ✓ {word}  →  {dst.name} ({kb:.0f} KB){note}')
    return word, dst.name


def read_list(csv: Path) -> list[tuple[str, str]]:
    if not csv.exists():
        return []
    rows = []
    for line in csv.read_text(encoding='utf-8').splitlines():
        word, sep, url = line.partition(',')
        if sep and url.strip().startswith('http'):
            rows.append((word.strip(), url.strip()))
    return rows


def write_list(csv: Path, rows: list[tuple[str, str]]) -> None:
    csv.write_text(''.join(f'{w}, {u}\n' for w, u in rows), encoding='utf-8')


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('sources', nargs='*', type=Path, help=f'pastas ou arquivos (padrão: {INBOX.relative_to(ROOT)}/)')
    ap.add_argument('--dest', type=Path, default=IMAGES, help='pasta de saída (padrão: images/)')
    ap.add_argument('--lista', default='vocabulario', help='nome do .csv da lista (padrão: vocabulario)')
    ap.add_argument('--base-url', default=BASE_URL, help='endereço público da pasta de saída')
    args = ap.parse_args()

    if sys.platform != 'darwin' or not shutil.which('sips'):
        print('Este script usa o "sips", que só existe no macOS.', file=sys.stderr)
        return 1

    if not args.sources:
        INBOX.mkdir(parents=True, exist_ok=True)
    files: list[Path] = []
    for s in args.sources or [INBOX]:
        if s.is_dir():
            files += sorted(p for p in s.iterdir() if p.suffix.lower() in KNOWN)
        elif s.suffix.lower() in KNOWN:
            files.append(s)
        else:
            print(f'  ✗ {s}: não é uma imagem conhecida, pulei')
    if not files:
        print(f'Nenhuma imagem encontrada. Coloque as imagens em {INBOX.relative_to(ROOT)}/ '
              'com o nome da palavra (ex.: cat.jpg).')
        return 1

    args.dest.mkdir(parents=True, exist_ok=True)
    base = args.base_url.rstrip('/') + '/'
    csv = args.dest / f'{slug(args.lista) or "vocabulario"}.csv'
    rows = read_list(csv)

    print(f'Processando {len(files)} imagem(ns):')
    added = []
    for f in files:
        try:
            r = process(f, args.dest)
        except subprocess.CalledProcessError as e:
            print(f'  ✗ {f.name}: o sips não conseguiu abrir ({(e.stderr or "").strip()})')
            continue
        if r:
            word, filename = r
            url = base + filename
            stem = filename.rsplit('.', 1)[0]
            same_file = lambda u: u.rsplit('/', 1)[-1].rsplit('.', 1)[0] == stem
            # imagem que já estava na lista: mantém o texto (pode ter sido editado) e a posição
            at = next((i for i, (_, u) in enumerate(rows) if same_file(u)), None)
            if at is not None:
                word = rows[at][0]
                rows[at] = (word, url)
            else:
                rows = [(w, u) for w, u in rows if w.lower() != word.lower()]
                rows.append((word, url))
            added.append((word, url))

    write_list(csv, rows)
    print(f'\n{csv.relative_to(ROOT) if csv.is_relative_to(ROOT) else csv}: {len(rows)} palavra(s).')
    if added:
        print('\nLinhas novas (cole na aba Vocabulário):')
        for w, u in added:
            print(f'{w}, {u}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
