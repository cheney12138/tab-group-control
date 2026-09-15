#!/usr/bin/env python3
"""第四轮:窗口 + 顶上一排**相邻**标签。

三轮下来的结论:孤立一个"上窄下宽的块"永远读不成标签(像瓶子、像碑)。
标签的可辨识性来自语境 —— 它长在窗口顶上,一排相邻、共底边,当前那张更高。
这轮就画这个语境。
"""

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from make_tabs import tab, rr, tile, CHROME, OUT, S   # noqa: E402
from make_flat import DEFAULT_COLOR                   # noqa: E402


# 1 —— 窗口 + 三张相邻标签(当前更高)
def c_win_strip():
    return (rr(14, 50, 100, 50, 13)
            + tab(17, 36, 29, 16, 6, opacity=.55)
            + tab(49, 30, 30, 22, 6, opacity=1)
            + tab(82, 36, 29, 16, 6, opacity=.55))


# 2 —— 窗口 + 三张等高相邻标签
def c_win_equal():
    return (rr(14, 50, 100, 50, 13)
            + tab(17, 32, 29, 20, 6, opacity=.6)
            + tab(49, 32, 30, 20, 6, opacity=1)
            + tab(82, 32, 29, 20, 6, opacity=.6))


# 3 —— 窗口 + 两张标签(最少元素)
def c_win_two():
    return (rr(14, 50, 100, 50, 13)
            + tab(22, 32, 42, 22, 8, opacity=.5)
            + tab(62, 26, 44, 28, 9, opacity=1))


# 4 —— 只留标签条:三张相邻标签坐一条细栏,当前更高
def c_bar_only():
    return (rr(14, 78, 100, 13, 6.5, opacity=.9)
            + tab(17, 40, 29, 40, 7, opacity=.5)
            + tab(49, 32, 30, 48, 7, opacity=1)
            + tab(82, 40, 29, 40, 7, opacity=.5))


# 5 —— 窗口 + 标签 + 组板(整组一块底板)
def c_win_plate():
    return (rr(12, 34, 104, 20, 9, opacity=.22)     # 组板
            + rr(14, 50, 100, 50, 13)                # 窗口
            + tab(17, 36, 29, 16, 6, opacity=.55)
            + tab(49, 30, 30, 22, 6, opacity=1)
            + tab(82, 36, 29, 16, 6, opacity=.55))


# 6 —— 窗口 + 三张等高标签,当前那张与内容连通得更明显(底边缺口)
def c_win_notch():
    return (rr(14, 48, 100, 52, 13)
            + tab(17, 34, 29, 18, 6, opacity=.55)
            + tab(49, 26, 30, 26, 7, opacity=1)
            + tab(82, 34, 29, 18, 6, opacity=.55))


CANDIDATES = {
    "1-win-strip": c_win_strip,
    "2-win-equal": c_win_equal,
    "3-win-two": c_win_two,
    "4-bar-only": c_bar_only,
    "5-win-plate": c_win_plate,
    "6-win-notch": c_win_notch,
}


def svg(body, px=S):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{px}" height="{px}" '
            f'viewBox="0 0 {S} {S}">{tile(DEFAULT_COLOR)}{body}</svg>')


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
    rows = []
    for name, fn in CANDIDATES.items():
        body = fn()
        for px in (128, 32, 16):
            render(svg(body, px), px, os.path.join(OUT, f"t4_{name}_{px}.png"))
        rows.append(
            f'<div class="row"><span class="lbl">{name}</span>'
            f'<img src="t4_{name}_128.png" width="92">'
            f'<img class="pix" src="t4_{name}_32.png" width="64">'
            f'<img class="pix" src="t4_{name}_16.png" width="48">'
            f'<img class="pix" src="t4_{name}_16.png" width="16"></div>')
    html = ('<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
            'body{margin:0;background:#eef1f5;font:11px -apple-system;color:#5a616b;padding:16px}'
            '.row{display:flex;align-items:flex-end;gap:18px;margin-bottom:10px}'
            '.lbl{width:100px}.pix{image-rendering:pixelated}img{display:block}'
            '</style></head><body>' + "".join(rows) + '</body></html>')
    p = os.path.join(OUT, "tabs4_sheet.html")
    open(p, "w").write(html)
    out = os.path.join(OUT, "tabs4_sheet.png")
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                    "--force-device-scale-factor=2", "--window-size=540,600",
                    "--default-background-color=ffffffff", f"--screenshot={out}",
                    f"file://{p}"], check=True, capture_output=True)
    print(out)


if __name__ == "__main__":
    main()
