#!/usr/bin/env python3
"""第五轮(收敛):等高标签条 —— 用"实心/半透"表示当前,而不是用高矮。

"三根不同高的柱"无论怎么画都会被读成柱状图。等高、只差明度,才读成"标签条上的一张当前标签"。
"""

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from make_tabs import tab, rr, tile, CHROME, OUT, S   # noqa: E402
from make_flat import DEFAULT_COLOR                   # noqa: E402


# F1 —— 三张等高标签 + 标签栏底条,中间实心(当前)
def f1():
    return (rr(13, 80, 102, 12, 6, opacity=.92)
            + tab(17, 40, 30, 46, 8, opacity=.42)
            + tab(49, 40, 30, 46, 8, opacity=1)
            + tab(81, 40, 30, 46, 8, opacity=.42))


# F2 —— 同上,不要底条(纯标签语言)
def f2():
    return (tab(17, 40, 30, 46, 8, opacity=.42)
            + tab(49, 40, 30, 46, 8, opacity=1)
            + tab(81, 40, 30, 46, 8, opacity=.42))


# F3 —— 等高 + 当前那张**略高一点点**(4pt),不至于读成柱状图
def f3():
    return (rr(13, 80, 102, 12, 6, opacity=.92)
            + tab(17, 42, 30, 44, 8, opacity=.42)
            + tab(49, 36, 30, 50, 9, opacity=1)
            + tab(81, 42, 30, 44, 8, opacity=.42))


# F4 —— 四张等高标签,第二张当前
def f4():
    return (rr(13, 80, 102, 12, 6, opacity=.92)
            + tab(15, 40, 22, 46, 7, opacity=.42)
            + tab(39, 40, 22, 46, 7, opacity=1)
            + tab(63, 40, 22, 46, 7, opacity=.42)
            + tab(87, 40, 22, 46, 7, opacity=.42))


# F5 —— 三张等高标签 + 底条,当前那张**与底条连成一体**(底条在它下面断开)
def f5():
    return (rr(13, 80, 30, 12, 6, opacity=.92)
            + rr(49, 80, 30, 12, 6, opacity=1)
            + rr(85, 80, 30, 12, 6, opacity=.92)
            + tab(17, 40, 30, 46, 8, opacity=.42)
            + tab(49, 40, 30, 46, 8, opacity=1)
            + tab(81, 40, 30, 46, 8, opacity=.42))


CANDIDATES = {
    "F1-equal+bar": f1,
    "F2-equal": f2,
    "F3-slight": f3,
    "F4-four": f4,
    "F5-seg": f5,
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
            render(svg(body, px), px, os.path.join(OUT, f"t5_{name}_{px}.png"))
        rows.append(
            f'<div class="row"><span class="lbl">{name}</span>'
            f'<img src="t5_{name}_128.png" width="92">'
            f'<img class="pix" src="t5_{name}_32.png" width="64">'
            f'<img class="pix" src="t5_{name}_16.png" width="48">'
            f'<img class="pix" src="t5_{name}_16.png" width="16"></div>')
    html = ('<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
            'body{margin:0;background:#eef1f5;font:11px -apple-system;color:#5a616b;padding:16px}'
            '.row{display:flex;align-items:flex-end;gap:18px;margin-bottom:10px}'
            '.lbl{width:100px}.pix{image-rendering:pixelated}img{display:block}'
            '</style></head><body>' + "".join(rows) + '</body></html>')
    p = os.path.join(OUT, "tabs5_sheet.html")
    open(p, "w").write(html)
    out = os.path.join(OUT, "tabs5_sheet.png")
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                    "--force-device-scale-factor=2", "--window-size=540,520",
                    "--default-background-color=ffffffff", f"--screenshot={out}",
                    f"file://{p}"], check=True, capture_output=True)
    print(out)


if __name__ == "__main__":
    main()
