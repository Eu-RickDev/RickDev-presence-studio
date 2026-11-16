import json
import re
import struct
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parent.parent
out = root / "build" / "splash"
out.mkdir(parents=True, exist_ok=True)
fonts = root / "src" / "renderer" / "fonts"

source = (root / "src" / "renderer" / "splash.js").read_text(encoding="utf-8")
block = re.search(r"const PHRASES = \[(.*?)\];", source, re.S).group(1)
phrases = [json.loads(m) for m in re.findall(r'"(?:[^"\\]|\\.)*"', block)]

W, H = 480, 270
BG = (20, 20, 21)
LINE = (37, 37, 38)
TEXT = (237, 237, 237)
TEXT_2 = (161, 161, 166)
MUTED = (133, 133, 139)
ACCENT = (240, 163, 58)
PHRASE_BOX = (36, 220, 444, 240)
BAR_Y, BAR_H, SEGMENT, SEGMENTS = 252, 2, 17, 24
FRAME_US, HOLD = 200000, 6
S = 2


def font(weight, size):
    return ImageFont.truetype(str(fonts / f"ibm-plex-sans-latin-{weight}-normal.woff2"), size * S)


def canvas():
    image = Image.new("RGB", (W * S, H * S), BG)
    return image, ImageDraw.Draw(image)


def finish(image):
    return image.resize((W, H), Image.LANCZOS)


def chunk(fourcc, data):
    return fourcc + struct.pack("<I", len(data)) + data + (b"\0" if len(data) % 2 else b"")


def rle8(pixels, width, height):
    encoded = bytearray()
    for y in range(height - 1, -1, -1):
        row = pixels[y * width:(y + 1) * width]
        i = 0
        while i < width:
            run = 1
            while i + run < width and run < 255 and row[i + run] == row[i]:
                run += 1
            if run > 1:
                encoded += bytes((run, row[i]))
                i += run
                continue
            start = i
            while i < width and i - start < 255 and (i + 1 >= width or row[i + 1] != row[i]):
                i += 1
            literal = row[start:i]
            if len(literal) >= 3:
                encoded += bytes((0, len(literal))) + literal + (b"\0" if len(literal) % 2 else b"")
            else:
                for value in literal:
                    encoded += bytes((1, value))
        encoded += b"\0\0"
    encoded[-2:] = b"\0\1"
    return bytes(encoded)


def write_avi(path, frames, sequence, usec_per_frame):
    width, height = frames[0].size
    stacked = Image.new("RGB", (width, height * len(frames)))
    for i, frame in enumerate(frames):
        stacked.paste(frame.convert("RGB"), (0, i * height))
    colors = [rgb for _, rgb in stacked.getcolors(maxcolors=width * height * len(frames))]
    if len(colors) > 256:
        indexed = stacked.quantize(colors=256, dither=Image.Dither.NONE)
    else:
        palette = Image.new("P", (1, 1))
        palette.putpalette([c for rgb in colors for c in rgb] + [0, 0, 0] * (256 - len(colors)))
        indexed = stacked.quantize(palette=palette, dither=Image.Dither.NONE)
    rgb_palette = indexed.getpalette()[:768]
    encoded = [rle8(indexed.crop((0, i * height, width, (i + 1) * height)).tobytes(), width, height) for i in range(len(frames))]
    largest = max(len(data) for data in encoded)
    count = len(sequence)

    avih = struct.pack("<14I", usec_per_frame, largest * 1000000 // usec_per_frame + 1, 0, 0x10, count, 0, 1, largest, width, height, 0, 0, 0, 0)
    strh = struct.pack("<4s4sIHHIIIIIIiI4h", b"vids", b"RLE ", 0, 0, 0, 0, usec_per_frame, 1000000, 0, count, largest, -1, 0, 0, 0, width, height)
    quads = b"".join(bytes((rgb_palette[i + 2], rgb_palette[i + 1], rgb_palette[i], 0)) for i in range(0, 768, 3))
    strf = struct.pack("<IiiHHIIiiII", 40, width, height, 1, 8, 1, largest, 0, 0, 256, 0) + quads
    hdrl = chunk(b"LIST", b"hdrl" + chunk(b"avih", avih) + chunk(b"LIST", b"strl" + chunk(b"strh", strh) + chunk(b"strf", strf)))

    movi, offsets, offset = b"", [], 4
    for data in encoded:
        piece = chunk(b"00dc", data)
        offsets.append(offset)
        movi += piece
        offset += len(piece)
    index = b"".join(struct.pack("<4sIII", b"00dc", 0x10, offsets[i], len(encoded[i])) for i in sequence)
    body = b"AVI " + hdrl + chunk(b"LIST", b"movi" + movi) + chunk(b"idx1", index)
    Path(path).write_bytes(b"RIFF" + struct.pack("<I", len(body)) + body)


image, draw = canvas()
draw.rectangle((0, 0, W * S - 1, H * S - 1), outline=LINE, width=S)
icon = Image.open(root / "build" / "icon.png").convert("RGBA").resize((64 * S, 64 * S), Image.LANCZOS)
image.paste(icon, (32 * S, 28 * S), icon)
draw.text((36 * S, 120 * S), "RickDev Presence Studio", font=font(600, 18), fill=TEXT)
draw.text((36 * S, 146 * S), "Rich Presence do Discord", font=font(400, 13), fill=MUTED)
draw.ellipse((36 * S, 202 * S, 44 * S, 210 * S), fill=ACCENT)
draw.text((52 * S, 196 * S), "Carregando", font=font(500, 14), fill=TEXT)
draw.rectangle((36 * S, BAR_Y * S, (36 + SEGMENT * SEGMENTS) * S - 1, (BAR_Y + BAR_H) * S - 1), fill=LINE)
finish(image).save(out / "fundo.bmp", format="BMP")

strips = []
for phrase in phrases:
    image, draw = canvas()
    draw.text((36 * S, 220 * S), phrase, font=font(400, 13), fill=TEXT_2)
    strips.append(finish(image).crop(PHRASE_BOX))
dimmed = [Image.blend(Image.new("RGB", strip.size, BG), strip, 0.5) for strip in strips]

count = len(strips)
sequence = []
for i in range(count):
    sequence += [count + i] + [i] * HOLD + [count + i]
write_avi(out / "frases.avi", strips + dimmed, sequence + sequence, FRAME_US)

Image.new("RGB", (SEGMENT, BAR_H), ACCENT).save(out / "barra.bmp", format="BMP")

lines = [
    f"!define RICKDEV_PHRASE_COUNT {count}",
    f"!define RICKDEV_PHRASE_FRAMES {HOLD + 2}",
    f"!define RICKDEV_BAR_SEGMENTS {SEGMENTS}",
    "",
]
(out / "frases.nsh").write_text("\n".join(lines), encoding="utf-8")
print(f"{count} frases em {out}")
