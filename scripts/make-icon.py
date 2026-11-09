"""Rebuild Rekindle's original vector mark and its extension PNG (requires Pillow)."""
from pathlib import Path
from PIL import Image, ImageDraw
ROOT = Path(__file__).resolve().parents[1]
svg = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" rx="56" fill="#101e29"/><path d="M207 78a88 88 0 1 0 7 87" fill="none" stroke="#70e5c0" stroke-width="16" stroke-linecap="round"/><path d="m185 80 25 3 6-26" fill="none" stroke="#70e5c0" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/><path d="m86 104 27 25-27 25m48 0h33" fill="none" stroke="#f6faf9" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/><circle cx="211" cy="132" r="10" fill="#ffad66"/></svg>'''
(ROOT / 'media/icon.svg').write_text(svg + '\n')
(ROOT / 'media/sessions.svg').write_text('''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#c5c5c5" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7a9 9 0 1 0 1 9M17 7h4V3M8 9l3 3-3 3m5 0h3"/></svg>\n''')
scale = 4
im = Image.new('RGB', (256*scale, 256*scale), '#101e29')
d = ImageDraw.Draw(im)
def line(points, color, width):
 pts=[(x*scale,y*scale) for x,y in points]; d.line(pts, fill=color,width=width*scale,joint='curve')
 for x,y in pts:
  r=width*scale/2;d.ellipse((x-r,y-r,x+r,y+r),fill=color)
d.arc(tuple(v*scale for v in (40,40,216,216)),start=36,end=326,fill='#70e5c0',width=16*scale)
line([(185,80),(210,83),(216,57)],'#70e5c0',16)
line([(86,104),(113,129),(86,154)],'#f6faf9',14)
line([(134,154),(167,154)],'#f6faf9',14)
d.ellipse((201*scale,122*scale,221*scale,142*scale),fill='#ffad66')
im.resize((256,256),Image.Resampling.LANCZOS).save(ROOT/'media/icon.png')
