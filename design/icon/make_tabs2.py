#!/usr/bin/env python3
"""第二轮:让标签页"一眼就是标签页"。

第一轮的病:等高的圆角方块并排 → 读成"窗口分栏/布局";斜向叠放 → 读成"复制/图层"。
这一轮抓浏览器标签的**真正特征**:
  · 标签底边是**开口的**(坐在一条标签栏上),不是四个角都收口的卡片
  · 当前标签**更高**、并与下方内容区连成一体(Chrome 的实读)
  · 多张标签沿**水平**方向排(不是斜向叠)
"""

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from make_tabs import tab, rr, tile, CHROME, OUT, S   # noqa: E402
from make_flat import DEFAULT_COLOR                    # noqa: E402


# 1 —— 标签条:三张标签坐在一条标签栏上,当前标签更高更亮
def c_strip_active():
    return (rr(14, 84, 100, 12, 6, opacity=.92)
            + tab(20, 46, 28, 40, 8, opacity=.45)
            + tab(50, 36, 28, 50, 9, opacity=1)
            + tab(80, 46, 28, 40, 8, opacity=.45))


# 2 —— 浏览器窗口:三张标签,当前那张与内容区连成一体(Chrome 的实读)
def c_window_active():
    return (rr(14, 52, 100, 56, 13)                # 内容区
            + tab(23, 36, 26, 20, 7, opacity=.5)   # 左标签
            + tab(51, 28, 30, 28, 8)               # 当前标签(与内容同色 → 连通)
            + tab(83, 36, 26, 20, 7, opacity=.5))  # 右标签


# 3 —— 标签沿水平方向叠放(一张压一张),最前面那张是当前
def c_deck():
    return (tab(16, 42, 46, 48, 11, opacity=.35)
            + tab(34, 42, 46, 48, 11, opacity=.6)
            + tab(54, 42, 58, 48, 12, opacity=1))


# 4 —— 三张标签 + 一块组板(整组共用底板 = 分组)
def c_group_plate():
    return (rr(14, 40, 100, 54, 15, opacity=.20)
            + tab(24, 34, 24, 48, 8, opacity=.55)
            + tab(52, 28, 24, 54, 8, opacity=1)
            + tab(80, 34, 24, 48, 8, opacity=.55))


# 5 —— 两张标签:一张正、一张从后面探出(最能读成"多个标签")
def c_peek2():
    return (tab(60, 40, 48, 52, 12, opacity=.45)
            + tab(20, 34, 54, 58, 13, opacity=1))


# 6 —— 标签条(横) + 当前标签上浮:纯标签语言,无容器
def c_bar_lift():
    return (tab(16, 50, 26, 36, 8, opacity=.42)
            + tab(50, 42, 28, 44, 9, opacity=1)
            + tab(84, 50, 26, 36, 8, opacity=.42))


CANDIDATES = {
    "1-strip-active": c_strip_active,
    "2-window-active": c_window_active,
    "3-deck": c_deck,
    "4-group-plate": c_group_plate,
    "5-peek2": c_peek2,
    "6-bar-lift": c_bar_lift,
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
            render(svg(body, px), px, os.path.join(OUT, f"t2_{name}_{px}.png"))
        rows.append(
            f'<div class="row"><span class="lbl">{name}</span>'
            f'<img src="t2_{name}_128.png" width="92">'
            f'<img class="pix" src="t2_{name}_32.png" width="64">'
            f'<img class="pix" src="t2_{name}_16.png" width="48">'
            f'<img class="pix" src="t2_{name}_16.png" width="16"></div>')
    html = ('<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
            'body{margin:0;background:#eef1f5;font:11px -apple-system;color:#5a616b;padding:16px}'
            '.row{display:flex;align-items:flex-end;gap:18px;margin-bottom:10px}'
            '.lbl{width:104px}.pix{image-rendering:pixelated}img{display:block}'
            '</style></head><body>' + "".join(rows) + '</body></html>')
    p = os.path.join(OUT, "tabs2_sheet.html")
    open(p, "w").write(html)
    out = os.path.join(OUT, "tabs2_sheet.png")
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                    "--force-device-scale-factor=2", "--window-size=540,600",
                    "--default-background-color=ffffffff", f"--screenshot={out}",
                    f"file://{p}"], check=True, capture_output=True)
    print(out)


if __name__ == "__main__":
    main()
