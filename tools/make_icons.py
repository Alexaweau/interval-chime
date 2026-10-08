"""Generate Interval Chime icons: bold dark bell on solid amber."""
from PIL import Image, ImageDraw
import os
OUT = os.path.join(os.path.dirname(__file__), '..', 'icons')
BG = (255, 176, 32); INK = (16, 19, 26)

def bell(size, scale=1.0):
    S = 1024
    im = Image.new('RGB', (S, S), BG)
    d = ImageDraw.Draw(im)
    c = S / 2
    def P(x, y):  # coordinates relative to center, scaled
        return (c + x * scale, c + y * scale)
    # knob
    r = 48
    d.ellipse([*P(-r, -330 - r), *P(r, -330 + r)], fill=INK)
    # dome + body as polygon approximating bell curve
    import math
    pts = []
    # right side: from top to rim
    prof = [(0, -300), (70, -296), (140, -278), (195, -245), (235, -195), (258, -130), (268, -60),
            (275, 20), (285, 90), (305, 150), (340, 195), (370, 225), (370, 255)]
    for x, y in prof: pts.append(P(x, y))
    for x, y in reversed(prof): pts.append(P(-x, y))
    d.polygon(pts, fill=INK)
    # smooth dome top with an ellipse
    d.ellipse([*P(-262, -300), *P(262, 0)], fill=INK)
    # rim bar
    d.rounded_rectangle([*P(-395, 225), *P(395, 290)], radius=int(32 * scale), fill=INK)
    # clapper
    r2 = 78
    d.ellipse([*P(-r2, 300), *P(r2, 300 + 2 * r2 - 20)], fill=INK)
    # highlight slit on bell for character
    d.rounded_rectangle([*P(-170, -150), *P(-120, 120)], radius=int(25 * scale), fill=BG)
    return im.resize((size, size), Image.LANCZOS)

os.makedirs(OUT, exist_ok=True)
bell(180, 0.82).save(os.path.join(OUT, 'apple-touch-icon.png'))
bell(192, 0.82).save(os.path.join(OUT, 'icon-192.png'))
bell(512, 0.82).save(os.path.join(OUT, 'icon-512.png'))
bell(512, 0.62).save(os.path.join(OUT, 'icon-maskable-512.png'))
bell(32, 0.95).save(os.path.join(OUT, 'favicon-32.png'))
print('ok')
