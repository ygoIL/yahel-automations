#!/usr/bin/env python3
"""Render on-screen text in yahel.tik's look as a transparent 1080x1920 PNG.

Styles (learned from yahel.tik, Nov 2026):
  reel  - reels: white text, thin black outline + soft shadow, centered in the upper third, no box (TikTok/Instagram "Classic").
  story - stories: light-pink rounded "pill" per line (#fdcafe) with purple text (#9c1fa8), emojis at the end of lines.
Usage: text_png.py '{"style":"reel","lines":["POV: ..."],"out":"/tmp/x.png","y":0.2}'
"""
import json, os, re, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = {'reel': os.path.join(HERE, 'fonts', 'Heebo-SemiBold.ttf'), 'story': os.path.join(HERE, 'fonts', 'Heebo-Bold.ttf')}
EMOJI_FONT = next((p for p in ['/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf', '/usr/share/fonts/noto/NotoColorEmoji.ttf'] if os.path.exists(p)), None)
W, H = 1080, 1920
EMOJI_RE = re.compile('[\U0001F000-\U0001FAFF☀-➿⬀-⯿️‍\U0001F3FB-\U0001F3FF]+')
PINK, PURPLE = (253, 202, 254, 255), (156, 31, 168, 255)


def split(line):
    """Text without emojis + list of emoji clusters (put at the end of the line, as in their stickers)."""
    emojis = EMOJI_RE.findall(line)
    return re.sub(r'\s+', ' ', EMOJI_RE.sub('', line)).strip(), emojis


def emoji_img(cluster, size):
    if not EMOJI_FONT:
        return None
    try:
        f = ImageFont.truetype(EMOJI_FONT, 109)
        im = Image.new('RGBA', (140 * max(1, len(cluster)), 140), (0, 0, 0, 0))
        ImageDraw.Draw(im).text((0, 0), cluster, font=f, embedded_color=True)
        bb = im.getbbox()
        if not bb:
            return None
        im = im.crop(bb)
        return im.resize((max(1, int(im.width * size / im.height)), size), Image.LANCZOS)
    except Exception:
        return None


def line_img(text, emojis, font, fill, stroke=0, stroke_fill=None):
    d = ImageDraw.Draw(Image.new('RGBA', (1, 1)))
    bb = d.textbbox((0, 0), text, font=font, direction='rtl', stroke_width=stroke) if text else (0, 0, 0, 0)
    tw, th = bb[2] - bb[0], bb[3] - bb[1]
    asc, desc = font.getmetrics()
    h = asc + desc + 2 * stroke
    ems = [e for e in (emoji_img(c, int(h * 0.8)) for c in emojis) if e]
    ew = sum(e.width + 8 for e in ems)
    im = Image.new('RGBA', (tw + ew + 2 * stroke + 4, h), (0, 0, 0, 0))
    dr = ImageDraw.Draw(im)
    if text:
        dr.text((ew + stroke - bb[0], stroke), text, font=font, fill=fill, direction='rtl', stroke_width=stroke, stroke_fill=stroke_fill)
    x = 0
    for e in ems:  # emojis sit at the end of a Hebrew line = left side
        im.alpha_composite(e, (x, (h - e.height) // 2)); x += e.width + 8
    return im


def fit(lines, style, max_w):
    size = 66 if style == 'reel' else 60
    while size > 34:
        font = ImageFont.truetype(FONTS[style], size, layout_engine=ImageFont.Layout.RAQM)
        imgs = [line_img(*split(l), font, (255, 255, 255, 255) if style == 'reel' else PURPLE,
                         stroke=4 if style == 'reel' else 0, stroke_fill=(0, 0, 0, 255)) for l in lines]
        if all(i.width <= max_w for i in imgs):
            return imgs
        size -= 4
    return imgs


def render(spec):
    style = spec.get('style', 'reel')
    lines = [str(l).strip() for l in spec.get('lines', []) if str(l).strip()][:5]
    canvas = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    if not lines:
        canvas.save(spec['out']); return
    imgs = fit(lines, style, 900)
    if style == 'reel':
        gap = 6
        total = sum(i.height for i in imgs) + gap * (len(imgs) - 1)
        y = int(H * float(spec.get('y', 0.2)))
        layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        yy = y
        for i in imgs:
            layer.alpha_composite(i, ((W - i.width) // 2, yy)); yy += i.height + gap
        # soft shadow under the outlined text for readability on bright backgrounds
        sh = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        sh.putalpha(layer.getchannel('A').point(lambda a: int(a * 0.45)))
        sh = sh.filter(ImageFilter.GaussianBlur(6))
        canvas.alpha_composite(sh, (3, 4)); canvas.alpha_composite(layer)
    else:
        padx, pady, gap = 34, 14, 10
        y = int(H * float(spec.get('y', 0.18)))
        for i in imgs:
            bw, bh = i.width + 2 * padx, i.height + 2 * pady
            x = (W - bw) // 2
            ImageDraw.Draw(canvas).rounded_rectangle((x, y, x + bw, y + bh), radius=bh // 2, fill=PINK)
            canvas.alpha_composite(i, (x + padx, y + pady)); y += bh + gap
    canvas.save(spec['out'])


if __name__ == '__main__':
    render(json.loads(sys.argv[1]))
