#!/usr/bin/env python3
"""第六轮:避开"竖中指"构图。

病因:三根竖直块里**中间那根又高又实、两侧半透** —— 这是个手势,不是图标。
修法两条,缺一不可:
  · 当前标签**不在中间**,挪到一侧(左/右)
  · 三张标签**等高**(不再用高矮区分),避免任何"中间突出"的剪影
备选另起一路:标签改为**水平叠放**(错位而非对称),对称手势读法从构图根上消失。
"""

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from mark import tab, rr, CHROME, OUT, S, DEFAULT_COLOR   # noqa: E402


# G1 —— 三张等高标签 + 标签栏,最左那张实心(当前)
def g1():
    return (rr(13, 80, 102, 12, 6, opacity=.92)
            + tab(17, 40, 30, 46, 8, opacity=1)
            + tab(49, 40, 30, 46, 8, opacity=.40)
            + tab(81, 40, 30, 46, 8, opacity=.40))


# G2 —— 同上,最右那张当前
def g2():
    return (rr(13, 80, 102, 12, 6, opacity=.92)
            + tab(17, 40, 30, 46, 8, opacity=.40)
            + tab(49, 40, 30, 46, 8, opacity=.40)
            + tab(81, 40, 30, 46, 8, opacity=1))


# G3 —— 窗口 + 顶上三张等高标签,最左那张与内容连通(浏览器实读)
def g3():
    return (rr(14, 50, 100, 50, 13)
            + tab(17, 32, 30, 20, 6, opacity=1)
            + tab(49, 32, 30, 20, 6, opacity=.5)
            + tab(81, 32, 30, 20, 6, opacity=.5))


# G4 —— 三张标签水平叠放(错位,非对称),最前那张当前
def g4():
    return (tab(14, 42, 44, 44, 10, opacity=.32)
            + tab(34, 42, 44, 44, 10, opacity=.55)
            + tab(56, 42, 58, 44, 11, opacity=1))


# G5 —— 两张标签 + 标签栏,左实心(最少元素)
def g5():
    return (rr(16, 80, 96, 12, 6, opacity=.92)
            + tab(22, 40, 42, 46, 10, opacity=1)
            + tab(66, 40, 42, 46, 10, opacity=.40))


# G6 —— 三张等高标签,不要底条;当前那张用**描边**而不是实心(明度差最小)
def g6():
    return (tab(17, 40, 30, 46, 8, opacity=.38)
            + tab(49, 40, 30, 46, 8, opacity=1)
            + tab(81, 40, 30, 46, 8, opacity=.38))


CANDIDATES = {
    "G1-left": g1,
    "G2-right": g2,
    "G3-window": g3,
    "G4-deck": g4,
    "G5-two": g5,
    "G6-mid": g6,
}


def svg(body, px=S):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{px}" height="{px}" '
            f'viewBox="0 0 {S} {S}">'
            f'<rect x="2" y="2" width="124" height="124" rx="28" fill="{DEFAULT_COLOR}"/>'
            f'{body}</svg>')


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
            render(svg(body, px), px, os.path.join(OUT, f"t6_{name}_{px}.png"))
        rows.append(
            f'<div class="row"><span class="lbl">{name}</span>'
            f'<img src="t6_{name}_128.png" width="92">'
            f'<img class="pix" src="t6_{name}_32.png" width="64">'
            f'<img class="pix" src="t6_{name}_16.png" width="48">'
            f'<img class="pix" src="t6_{name}_16.png" width="16"></div>')
    html = ('<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
            'body{margin:0;background:#eef1f5;font:11px -apple-system;color:#5a616b;padding:16px}'
            '.row{display:flex;align-items:flex-end;gap:18px;margin-bottom:10px}'
            '.lbl{width:88px}.pix{image-rendering:pixelated}img{display:block}'
            '</style></head><body>' + "".join(rows) + '</body></html>')
    p = os.path.join(OUT, "tabs6_sheet.html")
    open(p, "w").write(html)
    out = os.path.join(OUT, "tabs6_sheet.png")
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                    "--force-device-scale-factor=2", "--window-size=520,600",
                    "--default-background-color=ffffffff", f"--screenshot={out}",
                    f"file://{p}"], check=True, capture_output=True)
    print(out)


if __name__ == "__main__":
    main()
