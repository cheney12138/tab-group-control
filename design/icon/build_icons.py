#!/usr/bin/env python3
"""出图:把定稿标记(见 `mark.py`)渲染成 Chrome 扩展要的四档,写进 `icons/`。

四档 16/32/48/128(工具条 / 扩展页 / 商店),每档都从矢量直接栅格化。
"""

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from mark import svg, render, OUT   # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
ICONS = os.path.join(REPO, "icons")
SIZES = [16, 32, 48, 128]


def main():
    os.makedirs(ICONS, exist_ok=True)
    for px in SIZES:
        p = os.path.join(ICONS, f"icon{px}.png")
        render(svg(px=px), px, p)
        print("icon", px, "→", p)


if __name__ == "__main__":
    main()
