#!/usr/bin/env python3
"""扁平化配色探索:同一个标记(放大镜 + 一组标签),换底色的对照表。

扁平三戒:无渐变、无光泽、无投影。底色是一块纯色圆角方块,标记是纯白 + 挖空。
"""

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from make_logo import tabshape, bar, CHROME   # noqa: E402

OUT = os.path.join(HERE, "build")
S = 128.0

# 定稿色:纯色底 + 白色挖空。橙色 —— 不是蓝,且与扩展自带的 orange 强调色同源
DEFAULT_COLOR = "#E66A28"

COLORS = {
    "orange":  "#E66A28",
    "amber":   "#F0A020",
    "green":   "#34A853",
    "teal":    "#1BA39C",
    "rose":    "#E55375",
    "purple":  "#7B57D6",
    "graphite": "#31353D",
}

ACCENT_BAR = "#FDD663"   # Chrome 组色·暖黄(只在"带色组杠"变体里用)


def flat_tile(color):
    return f'<rect x="2" y="2" width="124" height="124" rx="28" fill="{color}"/>'


def flat_glyph(tile_color, bar_color=None):
    """纯白镜片 + 挖空的标签;组杠可选另一种纯色。"""
    s = f'<circle cx="58" cy="54" r="34" fill="#ffffff"/>'
    s += '<path d="M83 79 L99 95" stroke="#ffffff" stroke-width="14" stroke-linecap="round"/>'
    s += tabshape(41.5, 43, 9, 18, 3, fill=tile_color)
    s += tabshape(53.5, 35, 9, 26, 3, fill=tile_color)
    s += tabshape(65.5, 43, 9, 18, 3, fill=tile_color)
    s += bar(40, 65, 36, 7, 3.5, fill=bar_color or tile_color)
    return s


def svg(color=DEFAULT_COLOR, bar_color=None, px=S):
    body = flat_tile(color) + flat_glyph(color, bar_color)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{px}" height="{px}" '
            f'viewBox="0 0 {S} {S}">{body}</svg>')


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
    for name, color in COLORS.items():
        png = os.path.join(OUT, f"flat_{name}.png")
        render(svg(color), 128, png)
        cells.append(
            f'<div class="cell"><img src="flat_{name}.png" width="96">'
            f'<span>{name}</span><code>{color}</code></div>')
    # 带色组杠的一版(唯一第二色)
    png = os.path.join(OUT, "flat_orange_bar.png")
    render(svg(COLORS["orange"], ACCENT_BAR), 128, png)
    cells.append(
        f'<div class="cell"><img src="flat_orange_bar.png" width="96">'
        f'<span>orange · 组杠</span><code>{ACCENT_BAR}</code></div>')
    html = ('<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
            'body{margin:0;background:#eef1f5;font:11px -apple-system;color:#5a616b;padding:20px;'
            'display:flex;flex-wrap:wrap;gap:18px 22px;max-width:760px}'
            '.cell{display:flex;flex-direction:column;align-items:center;gap:5px}'
            'code{color:#98a1ad}img{display:block}</style></head><body>'
            + "".join(cells) + '</body></html>')
    p = os.path.join(OUT, "flat_sheet.html")
    open(p, "w").write(html)
    out = os.path.join(OUT, "flat_sheet.png")
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                    "--force-device-scale-factor=2", "--window-size=760,320",
                    "--default-background-color=ffffffff", f"--screenshot={out}",
                    f"file://{p}"], check=True, capture_output=True)
    print(out)


if __name__ == "__main__":
    main()
