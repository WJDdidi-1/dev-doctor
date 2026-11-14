#!/usr/bin/env python3
"""Render the README terminal screencast (docs/demo.gif) from a frames file.

The frames file is JSON written by scripts/render-demo.mjs, which runs
docs/demo.tape against the live CLI — so every output line shown here
is real current output, captured minutes ago, never hand-typed. This
script only draws pixels: a dark terminal (bg #0B1016, green prompt,
white text, blue section headers), commands typed character by
character. 1024x576, 10 fps, animated GIF via ffmpeg
palettegen/paletteuse — mp4 does not render in a GitHub README, GIF does.

Usage: python3 scripts/render-demo.py --frames <frames.json> --out <demo.gif>
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

W, H = 1024, 576
FPS = 10
COLORS = {
    'WHITE': (202, 207, 213),
    'GREEN': (88, 164, 102),
    'BLUE': (98, 164, 238),
    'AMBER': (227, 179, 65),
    'RED': (240, 113, 120),
    'DIM': (120, 128, 140),
}
BG = (11, 16, 22)

MONO = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'
MONO_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'
SANS_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'

font_term = ImageFont.truetype(MONO, 15)
font_term_bold = ImageFont.truetype(MONO_BOLD, 15)
font_title = ImageFont.truetype(SANS_BOLD, 34)
font_title_small = ImageFont.truetype(SANS_BOLD, 22)
font_end = ImageFont.truetype(MONO_BOLD, 28)
font_end_small = ImageFont.truetype(MONO, 20)

LINE_H = 21
MARGIN_X = 24
MARGIN_Y = 24


def color(name):
    try:
        return COLORS[name]
    except KeyError:
        raise SystemExit(f'render-demo: unknown color {name!r}')


class Renderer:
    def __init__(self, frames_data):
        self.label = frames_data['label']
        self.frames = []

    def base_frame(self):
        im = Image.new('RGB', (W, H), BG)
        d = ImageDraw.Draw(im)
        w = d.textlength(self.label, font=font_term_bold)
        d.text((W - MARGIN_X - w, 8), self.label, font=font_term_bold, fill=COLORS['AMBER'])
        return im, d

    def add_frames(self, n, render):
        for i in range(n):
            self.frames.append(render(i, n))

    def title_card(self, seconds, lines, sub=None):
        n = int(seconds * FPS)

        def render(i, _n):
            im, d = self.base_frame()
            y = H // 2 - 70
            for line, font in lines:
                w = d.textlength(line['text'], font=font)
                d.text(((W - w) / 2, y), line['text'], font=font, fill=color(line['color']))
                y += 52 if font is font_title else 34
            if sub:
                w = d.textlength(sub, font=font_title_small)
                d.text(((W - w) / 2, y + 16), sub, font=font_title_small, fill=COLORS['DIM'])
            return im

        self.add_frames(n, render)

    def term_scene(self, cmd_lines, out_lines, hold=2.0, type_cps=45):
        """Type cmd_lines, then reveal out_lines one by one, then hold."""
        total_chars = sum(len(item['text']) for item in cmd_lines)
        n_type = max(1, int(total_chars / type_cps * FPS))

        def render_type(i, n):
            shown = int((i + 1) / n * total_chars)
            lines = []
            remaining = shown
            for item in cmd_lines:
                take = min(len(item['text']), remaining)
                lines.append((item['prefix'] + item['text'][:take], 'WHITE'))
                if take < len(item['text']):
                    break
                remaining -= take
            im, d = self.base_frame()
            y = MARGIN_Y
            for j, (text, _color) in enumerate(lines):
                prefix = cmd_lines[j]['prefix']
                d.text((MARGIN_X, y), prefix, font=font_term, fill=COLORS['GREEN'])
                d.text((MARGIN_X + font_term.getlength(prefix), y), text[len(prefix):],
                       font=font_term, fill=COLORS['WHITE'])
                y += LINE_H
            last = lines[-1][0]
            cx = MARGIN_X + font_term.getlength(last)
            cy = MARGIN_Y + (len(lines) - 1) * LINE_H
            d.rectangle([cx, cy + 1, cx + 9, cy + 17], fill=COLORS['WHITE'])
            return im

        self.add_frames(n_type, render_type)

        shown_lines = [(item['prefix'] + item['text'], 'WHITE') for item in cmd_lines]
        n_out = len(out_lines) * 3

        def render_out(i, _n):
            upto = min(len(out_lines), i // 3 + 1)
            lines = shown_lines + [(item['text'], item['color']) for item in out_lines[:upto]]
            im, d = self.base_frame()
            y = MARGIN_Y
            for text, color_name in lines:
                if text.startswith('$ ') or text.startswith('> '):
                    d.text((MARGIN_X, y), text[:2], font=font_term, fill=COLORS['GREEN'])
                    d.text((MARGIN_X + font_term.getlength(text[:2]), y), text[2:],
                           font=font_term, fill=COLORS['WHITE'])
                else:
                    d.text((MARGIN_X, y), text, font=font_term, fill=color(color_name))
                y += LINE_H
            cy = y
            d.text((MARGIN_X, cy), '$', font=font_term, fill=COLORS['GREEN'])
            d.rectangle([MARGIN_X + font_term.getlength('$ '), cy + 1,
                         MARGIN_X + font_term.getlength('$ ') + 9, cy + 17], fill=COLORS['WHITE'])
            return im

        self.add_frames(n_out, render_out)
        final = render_out(n_out - 1, n_out)
        self.add_frames(int(hold * FPS), lambda i, _n, f=final: f.copy())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--frames', required=True)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    with open(args.frames, encoding='utf-8') as f:
        data = json.load(f)

    # Longest shown line must fit the frame.
    longest = ''
    for scene in data['scenes']:
        for item in scene['outLines']:
            if len(item['text']) > len(longest):
                longest = item['text']
        for item in scene['cmdLines']:
            text = item['prefix'] + item['text']
            if len(text) > len(longest):
                longest = text
    if font_term.getlength(longest) > W - 2 * MARGIN_X:
        raise SystemExit(f'render-demo: line too long for the frame: {longest!r}')

    r = Renderer(data)
    title = data['title']
    r.title_card(2.5, [
        (title['lines'][0], font_title),
        (title['lines'][1], font_title),
    ], sub=title['sub'])
    for scene in data['scenes']:
        r.term_scene(scene['cmdLines'], scene['outLines'], hold=scene['hold'])
    end = data['end']
    r.title_card(3.5, [
        (end['lines'][0], font_end),
        (end['lines'][1], font_end_small),
    ], sub=end['sub'])

    print(f'frames: {len(r.frames)}  duration: {len(r.frames) / FPS:.1f}s')
    tmp = tempfile.mkdtemp(prefix='dev-diagnosis-gif-')
    try:
        for i, im in enumerate(r.frames):
            im.save(f'{tmp}/f{i:04d}.png')
        palette = os.path.join(tmp, 'palette.png')
        subprocess.run(['ffmpeg', '-y', '-v', 'error', '-framerate', str(FPS),
                        '-i', f'{tmp}/f%04d.png', '-vf', 'palettegen', palette],
                       check=True)
        subprocess.run(['ffmpeg', '-y', '-v', 'error', '-framerate', str(FPS),
                        '-i', f'{tmp}/f%04d.png', '-i', palette,
                        '-lavfi', 'paletteuse', args.out], check=True)
    finally:
        for name in os.listdir(tmp):
            os.unlink(os.path.join(tmp, name))
        os.rmdir(tmp)
    print(f'wrote {args.out} ({os.path.getsize(args.out)} bytes)')


if __name__ == '__main__':
    main()
