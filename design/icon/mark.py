#!/usr/bin/env python3
"""Tab Group Search 图标的**定稿源**。

主体 = 浏览器标签条:三张**等高**标签坐在一条标签栏上,最左那张最亮 = 当前。
风格 = 黑白色 + 拟物:灰阶渐变(面)、顶高光、斜面边、下落影 —— 有体积,零彩色。

⚠️ 两条红线(评审踩出来的,别再犯):
  1. **禁止中间那张突出/最亮**。三根竖块、中间一根又高又亮 = **竖中指**(用户实评)。
     当前标签必须在**一侧**,且三张**等高**。
  2. **禁用"高矮"区分当前** —— 那是柱状图。只能靠**明度/明暗**(当前最亮)。
     标签**宽 > 高**,否则读成键盘按键。

走过的弯路(留档,别再回去):
  · 放大镜里放三根柱 → "图表/图标工具"(用户实评)
  · 圆角矩形等高并排 → "窗口分栏"
  · 斜向叠放 → "复制/图层"
  · 上窄下宽的梯形 → "瓶子/碑"
  · 中间一根又高又实 → "竖中指"(用户实评)
"""

import os
import subprocess

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "build")
S = 128.0

DEFAULT_COLOR = "#E66A28"   # 旧扁平版的底色(仅早期探索脚本仍在引用)


# ----------------------------------------------------------------- 形状

def rr(x, y, w, h, r, fill="#fff", opacity=1.0):
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" ry="{r}" '
            f'fill="{fill}" opacity="{opacity}"/>')


def tab_path(x, y, w, h, r):
    """浏览器标签页:顶角圆、底角方(底边开口,坐进标签栏)。"""
    return (f"M{x} {y+h} V{y+r} Q{x} {y} {x+r} {y} "
            f"H{x+w-r} Q{x+w} {y} {x+w} {y+r} V{y+h} Z")


def tile_path(x=2, y=2, w=124, h=124, r=28):
    return (f'M{x+r} {y} H{x+w-r} Q{x+w} {y} {x+w} {y+r} V{y+h-r} '
            f'Q{x+w} {y+h} {x+w-r} {y+h} H{x+r} Q{x} {y+h} {x} {y+h-r} '
            f'V{y+r} Q{x} {y} {x+r} {y} Z')


def tab(x, y, w, h, r, fill="#fff", opacity=1.0):
    return f'<path d="{tab_path(x, y, w, h, r)}" fill="{fill}" opacity="{opacity}"/>'


# ----------------------------------------------------------------- 拟物材质

def defs():
    g = {
        "tile":    ("#5a5a63", "#2b2b33", "#131317"),
        "bar":     ("#d9d9df", "#8f8f99"),
        "faceIdle": ("#e9e9ee", "#a9a9b3"),
        "faceActive": ("#ffffff", "#d8d8df"),
    }
    return f'''
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{g['tile'][0]}"/>
      <stop offset="0.52" stop-color="{g['tile'][1]}"/>
      <stop offset="1" stop-color="{g['tile'][2]}"/>
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
      <stop offset="0" stop-color="{g['bar'][0]}"/>
      <stop offset="1" stop-color="{g['bar'][1]}"/>
    </linearGradient>
    <linearGradient id="faceIdle" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{g['faceIdle'][0]}"/>
      <stop offset="1" stop-color="{g['faceIdle'][1]}"/>
    </linearGradient>
    <linearGradient id="faceActive" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{g['faceActive'][0]}"/>
      <stop offset="1" stop-color="{g['faceActive'][1]}"/>
    </linearGradient>
    <linearGradient id="bevel" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".85"/>
      <stop offset="0.55" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity=".30"/>
    </linearGradient>
    <filter id="tileShadow" x="-25%" y="-25%" width="150%" height="150%">
      <feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#000" flood-opacity=".38"/>
    </filter>
    <filter id="tabShadow" x="-40%" y="-40%" width="180%" height="200%">
      <feDropShadow dx="0" dy="2.5" stdDeviation="2.6" flood-color="#000" flood-opacity=".42"/>
    </filter>'''


def body():
    g = []
    # 底板:渐变 + 内缘 + 顶部光泽
    g.append(f'<path d="{tile_path()}" fill="url(#tile)" filter="url(#tileShadow)"/>')
    g.append(f'<path d="{tile_path()}" fill="none" stroke="url(#tileRim)" stroke-width="1.6"/>')
    g.append('<path d="M30 2 H98 Q126 2 126 30 V62 H2 V30 Q2 2 30 2 Z" fill="url(#gloss)"/>')
    # 标签栏
    g.append(rr(9, 78, 110, 15, 7.5, fill="url(#bar)"))
    g.append('<rect x="9.6" y="78.6" width="108.8" height="13.8" rx="6.9" fill="none" '
             'stroke="#ffffff" stroke-opacity=".35" stroke-width="1.1"/>')
    # 三张等高标签:当前在最左(最亮),其余压暗;宽 > 高
    for x, face in ((11, "faceActive"), (47, "faceIdle"), (83, "faceIdle")):
        d = tab_path(x, 52, 34, 30, 8)
        g.append(f'<g filter="url(#tabShadow)">'
                 f'<path d="{d}" fill="url(#{face})"/>'
                 f'<path d="{d}" fill="none" stroke="url(#bevel)" stroke-width="1.4"/></g>')
        g.append(f'<path d="{tab_path(x + 3, 55, 28, 10, 4)}" fill="#ffffff" opacity=".26"/>')
    return "".join(g)


def svg(px=S):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{px}" height="{px}" '
            f'viewBox="0 0 {S} {S}"><defs>{defs()}</defs>{body()}</svg>')


def render(markup, px, path):
    html = (f'<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{{margin:0;'
            f'background:transparent;overflow:hidden}}</style></head><body>{markup}</body></html>')
    hp = os.path.join(OUT, "_" + os.path.basename(path) + ".html")
    open(hp, "w").write(html)
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                    "--force-device-scale-factor=1", f"--window-size={px},{px}",
                    "--default-background-color=00000000", f"--screenshot={path}",
                    f"file://{hp}"], check=True, capture_output=True)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    p = os.path.join(OUT, "mark-128.png")
    render(svg(px=128), 128, p)
    print(p)
