#!/usr/bin/env python3
"""拟物(黑白色)方向探索:给标签条做体积。

扁平三戒解除 —— 这一版要的就是:渐变(面)、高光(顶)、斜面(边)、投影(下)。
色相全锁在灰阶:黑 / 白 / 灰,零彩色。
两案:暗底(石墨黑)+ 亮底(银灰),对比着看。
"""

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from mark import tab, rr, CHROME, OUT, S   # noqa: E402


def tile_path(x=2, y=2, w=124, h=124, r=28):
    return (f'M{x+r} {y} H{x+w-r} Q{x+w} {y} {x+w} {y+r} V{y+h-r} '
            f'Q{x+w} {y+h} {x+w-r} {y+h} H{x+r} Q{x} {y+h} {x} {y+h-r} '
            f'V{y+r} Q{x} {y} {x+r} {y} Z')


def tab_path(x, y, w, h, r):
    return (f"M{x} {y+h} V{y+r} Q{x} {y} {x+r} {y} "
            f"H{x+w-r} Q{x+w} {y} {x+w} {y+r} V{y+h} Z")


def defs(theme):
    if theme == "dark":
        tile_top, tile_mid, tile_bot = "#5a5a63", "#2b2b33", "#131317"
        face_top, face_bot = "#e9e9ee", "#a9a9b3"        # 非当前标签
        act_top, act_bot = "#ffffff", "#d8d8df"          # 当前标签
        bar_top, bar_bot = "#d9d9df", "#8f8f99"
        bevel_top, bevel_bot = ".85", ".30"
    else:
        tile_top, tile_mid, tile_bot = "#ffffff", "#dcdce2", "#b6b6bf"
        face_top, face_bot = "#c9c9d1", "#8e8e99"
        act_top, act_bot = "#ffffff", "#dcdee4"
        bar_top, bar_bot = "#6f6f79", "#4a4a53"
        bevel_top, bevel_bot = ".95", ".35"
    return f'''
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{tile_top}"/>
      <stop offset="0.52" stop-color="{tile_mid}"/>
      <stop offset="1" stop-color="{tile_bot}"/>
    </linearGradient>
    <linearGradient id="tileRim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".55"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity=".06"/>
      <stop offset="1" stop-color="#000000" stop-opacity=".40"/>
    </linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".34"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="bar" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{bar_top}"/>
      <stop offset="1" stop-color="{bar_bot}"/>
    </linearGradient>
    <linearGradient id="faceIdle" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{face_top}"/>
      <stop offset="1" stop-color="{face_bot}"/>
    </linearGradient>
    <linearGradient id="faceActive" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{act_top}"/>
      <stop offset="1" stop-color="{act_bot}"/>
    </linearGradient>
    <linearGradient id="bevel" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="{bevel_top}"/>
      <stop offset="0.55" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="{bevel_bot}"/>
    </linearGradient>
    <filter id="tileShadow" x="-25%" y="-25%" width="150%" height="150%">
      <feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#000" flood-opacity=".38"/>
    </filter>
    <filter id="tabShadow" x="-40%" y="-40%" width="180%" height="200%">
      <feDropShadow dx="0" dy="2.5" stdDeviation="2.6" flood-color="#000" flood-opacity=".42"/>
    </filter>'''


def body(theme):
    g = []
    # 底板
    g.append(f'<path d="{tile_path()}" fill="url(#tile)" filter="url(#tileShadow)"/>')
    g.append(f'<path d="{tile_path()}" fill="none" stroke="url(#tileRim)" stroke-width="1.6"/>')
    # 顶部光泽
    g.append('<path d="M30 2 H98 Q126 2 126 30 V62 H2 V30 Q2 2 30 2 Z" fill="url(#gloss)"/>')
    # 标签栏
    g.append(rr(9, 78, 110, 15, 7.5, fill="url(#bar)"))
    g.append('<rect x="9.6" y="78.6" width="108.8" height="13.8" rx="6.9" fill="none" '
             'stroke="#ffffff" stroke-opacity=".35" stroke-width="1.1"/>')
    # 三张等高标签(当前在最左;宽 > 高,避免读成按键)
    tabs = [(11, 1.0, "faceActive"), (47, .82, "faceIdle"), (83, .82, "faceIdle")]
    for x, _op, face in tabs:
        d = tab_path(x, 52, 34, 30, 8)
        g.append(f'<g filter="url(#tabShadow)">'
                 f'<path d="{d}" fill="url(#{face})"/>'
                 f'<path d="{d}" fill="none" stroke="url(#bevel)" stroke-width="1.4"/></g>')
        # 标签面部高光:靠上一条窄白
        g.append(f'<path d="{tab_path(x + 3, 55, 28, 10, 4)}" fill="#ffffff" opacity=".26"/>')
    return "".join(g)


def svg(theme, px=S):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{px}" height="{px}" '
            f'viewBox="0 0 {S} {S}"><defs>{defs(theme)}</defs>{body(theme)}</svg>')


def render(markup, px, path):
    html = (f'<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{{margin:0;'
            f'background:transparent;overflow:hidden}}</style></head><body>{markup}</body></html>')
    hp = os.path.join(OUT, "_" + os.path.basename(path) + ".html")
    open(hp, "w").write(html)
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                    "--force-device-scale-factor=1", f"--window-size={px},{px}",
                    "--default-background-color=00000000", f"--screenshot={path}",
                    f"file://{hp}"], check=True, capture_output=True)


def main():
    os.makedirs(OUT, exist_ok=True)
    cells = []
    for theme in ("dark", "light"):
        for px in (128, 32, 16):
            render(svg(theme, px), px, os.path.join(OUT, f"sk_{theme}_{px}.png"))
        cells.append(
            f'<div class="col"><img src="sk_{theme}_128.png" width="128">'
            f'<div class="sm"><img class="pix" src="sk_{theme}_32.png" width="64">'
            f'<img class="pix" src="sk_{theme}_16.png" width="48">'
            f'<img class="pix" src="sk_{theme}_16.png" width="16"></div>'
            f'<span>{theme}</span></div>')
    html = ('<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
            'body{margin:0;background:#f2f3f5;font:12px -apple-system;color:#5a616b;padding:24px;'
            'display:flex;gap:48px}.col{display:flex;flex-direction:column;align-items:center;gap:8px}'
            '.sm{display:flex;align-items:flex-end;gap:14px}.pix{image-rendering:pixelated}'
            'img{display:block}</style></head><body>' + "".join(cells) + '</body></html>')
    p = os.path.join(OUT, "skeu_sheet.html")
    open(p, "w").write(html)
    out = os.path.join(OUT, "skeu_sheet.png")
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                    "--allow-file-access-from-files", "--virtual-time-budget=3000",
                    "--force-device-scale-factor=2", "--window-size=520,260",
                    "--default-background-color=ffffffff", f"--screenshot={out}",
                    f"file://{p}"], check=True, capture_output=True)
    print(out)


if __name__ == "__main__":
    main()
