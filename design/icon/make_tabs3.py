#!/usr/bin/env python3
"""第三轮:换成**梯形标签**(上窄下宽 + 顶角圆)。

圆角矩形并排的读法太多:窗口分栏、布局、卡片。浏览器标签真正一眼可辨的剪影是
"Safari 式梯形":上窄下宽、顶角圆、底边开口坐进标签栏。这一轮只换标签剪影,组合方式沿用第二轮。
"""

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from make_tabs import rr, tile, CHROME, OUT, S   # noqa: E402
from make_flat import DEFAULT_COLOR              # noqa: E402


def trap(x, y, w, h, inset=5.0, r=5.0, fill="#fff", opacity=1.0):
    """梯形标签:底宽 w、顶宽 w-2*inset,顶角圆。"""
    x0, x1 = x + inset, x + w - inset
    d = (f"M{x} {y+h} L{x0} {y+r} Q{x0} {y} {x0+r} {y} "
         f"L{x1-r} {y} Q{x1} {y} {x1} {y+r} L{x+w} {y+h} Z")
    return f'<path d="{d}" fill="{fill}" opacity="{opacity}"/>'


# 1 —— 三张梯形标签并排,中间是当前
def c_trap3():
    return (trap(18, 42, 29, 46, opacity=.5)
            + trap(50, 42, 29, 46, opacity=1)
            + trap(81, 42, 29, 46, opacity=.5))


# 2 —— 三张梯形标签 + 标签栏底条
def c_trap3_bar():
    return (rr(16, 84, 96, 11, 5.5, opacity=.92)
            + trap(20, 40, 29, 48, opacity=.5)
            + trap(50, 34, 30, 54, opacity=1)
            + trap(80, 40, 29, 48, opacity=.5))


# 3 —— 窗口 + 梯形标签(当前标签与内容连通)
def c_trap_window():
    return (rr(15, 54, 98, 54, 12)
            + trap(22, 38, 27, 22, opacity=.5)
            + trap(50, 30, 31, 30)
            + trap(81, 38, 27, 22, opacity=.5))


# 4 —— 两张梯形标签水平叠放(前一张当前)
def c_trap_two():
    return (trap(24, 44, 56, 44, opacity=.42)
            + trap(50, 40, 58, 48, opacity=1))


# 5 —— 三张梯形标签 + 组板(整组共用底板)
def c_trap_plate():
    return (rr(14, 42, 100, 52, 15, opacity=.20)
            + trap(23, 36, 26, 50, opacity=.55)
            + trap(51, 30, 26, 56, opacity=1)
            + trap(79, 36, 26, 50, opacity=.55))


# 6 —— 一张大梯形标签 + 右侧探出一张(最少元素)
def c_trap_peek():
    return (trap(62, 44, 46, 44, opacity=.42)
            + trap(20, 36, 58, 52, opacity=1))


CANDIDATES = {
    "1-trap3": c_trap3,
    "2-trap3+bar": c_trap3_bar,
    "3-trap-window": c_trap_window,
    "4-trap-two": c_trap_two,
    "5-trap-plate": c_trap_plate,
    "6-trap-peek": c_trap_peek,
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
            render(svg(body, px), px, os.path.join(OUT, f"t3_{name}_{px}.png"))
        rows.append(
            f'<div class="row"><span class="lbl">{name}</span>'
            f'<img src="t3_{name}_128.png" width="92">'
            f'<img class="pix" src="t3_{name}_32.png" width="64">'
            f'<img class="pix" src="t3_{name}_16.png" width="48">'
            f'<img class="pix" src="t3_{name}_16.png" width="16"></div>')
    html = ('<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
            'body{margin:0;background:#eef1f5;font:11px -apple-system;color:#5a616b;padding:16px}'
            '.row{display:flex;align-items:flex-end;gap:18px;margin-bottom:10px}'
            '.lbl{width:104px}.pix{image-rendering:pixelated}img{display:block}'
            '</style></head><body>' + "".join(rows) + '</body></html>')
    p = os.path.join(OUT, "tabs3_sheet.html")
    open(p, "w").write(html)
    out = os.path.join(OUT, "tabs3_sheet.png")
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                    "--force-device-scale-factor=2", "--window-size=540,600",
                    "--default-background-color=ffffffff", f"--screenshot={out}",
                    f"file://{p}"], check=True, capture_output=True)
    print(out)


if __name__ == "__main__":
    main()
