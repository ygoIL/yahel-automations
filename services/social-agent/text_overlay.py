#!/usr/bin/env python3
"""Transparent 1080x1920 PNG with on-screen text in yahel.tik's look (learned from the account, Nov 2026).

reel  : white text, thin black outline, centered, upper third - like the account's POV reels.
story : light-pink rounded pills with purple text, one pill per line, emojis at the end of the line.
Usage: text_overlay.py <reel|story> <out.png> <line> [line ...]
"""
import os, re, sys
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = os.path.join(HERE, 'fonts', 'Heebo-Bold.ttf')
EMOJI_FONTS = ['/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf', os.path.join(HERE, 'fonts', 'NotoColorEmoji.ttf')]
W, H = 1080, 1920
PINK, PURPLE = (253, 202, 254, 255), (160, 31, 172, 255)
EMO = re.compile('[\U0001F000-\U0001FAFF☀-➿⬀-⯿️‍\U0001F3FB-\U0001F3FF]+')


def emoji_img(chars, px):
    path = next((p for p in EMOJI_FONTS if os.path.exists(p)), None)
    if not path or not chars:
        return None
    f = ImageFont.truetype(path, 109)
    im = Image.new('RGBA', (140 * len(chars), 140), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((0, 0), chars, font=f, embedded_color=True)
    bb = im.getbbox()
    if not bb:
        return None
    im = im.crop(bb)
    return im.resize((max(1, int(im.width * px / im.height)), px), Image.LANCZOS)


def split(line):
    emo = ''.join(EMO.findall(line))
    text = EMO.sub('', line).strip()
    return text, emo


def draw_line(canvas, text, emo, y, font, style):
    d = ImageDraw.Draw(canvas)
    t = '‏' + text + '‏' if text else ''
    bb = d.textbbox((0, 0), t, font=font, direction='rtl', stroke_width=5 if style == 'reel' else 0) if t else (0, 0, 0, 0)
    tw, th = bb[2] - bb[0], font.size
    e = emoji_img(emo, int(font.size * 0.95))
    gap = 14 if e else 0
    total = tw + gap + (e.width if e else 0)
    x0 = (W - total) // 2
    if style == 'story':
        pad_x, pad_y = 38, 22
        d.rounded_rectangle((x0 - pad_x, y - pad_y, x0 + total + pad_x, y + th + pad_y + 8), radius=(th + 2 * pad_y) // 2, fill=PINK)
    if e:  # emojis sit at the end of a Hebrew line = left side
        canvas.alpha_composite(e, (x0, y + (th - e.height) // 2 + 6))
    if t:
        tx = x0 + (e.width + gap if e else 0) - bb[0]
        if style == 'reel':
            d.text((tx, y - bb[1] + 4), t, font=font, fill='white', stroke_width=5, stroke_fill='black', direction='rtl')
        else:
            d.text((tx, y - bb[1] + 4), t, font=font, fill=PURPLE, direction='rtl')
    return th


def main():
    style, out, lines = sys.argv[1], sys.argv[2], [l for l in sys.argv[3:] if l.strip()]
    canvas = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    size = 74 if style == 'reel' else 64
    longest = max((len(split(l)[0]) for l in lines), default=1)
    if longest > 22:
        size = int(size * 22 / longest) + 4
    font = ImageFont.truetype(FONT, size, layout_engine=ImageFont.Layout.RAQM)
    step = int(size * (1.35 if style == 'reel' else 1.75))
    y = int(H * (0.24 if style == 'reel' else 0.20))
    for l in lines:
        text, emo = split(l)
        draw_line(canvas, text, emo, y, font, style)
        y += step
    canvas.save(out)


if __name__ == '__main__':
    main()
