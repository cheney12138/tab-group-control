#!/usr/bin/env python3
"""出图:把**外部设计稿母图**缩放成 Chrome 扩展要的四档,写进 `icons/`。

与 `build_icons.py` 的分工:
  - `build_icons.py`      —— 自绘标记,由 `mark.py` 的矢量直接栅格化(旧定稿:黑白标签条)
  - `build_from_master.py` —— 外部设计稿(位图母图),除等比缩放外不做任何处理

母图 `tab-logo-master.png` 是设计原稿(1254×1254,自带 alpha,留白与圆角外全透明),
它是**唯一真源**:改设计就换这张图,然后重跑本脚本,不要手改 `icons/` 里的 PNG。

    python3 design/icon/build_from_master.py     # → icons/icon{16,32,48,128}.png

依赖 Pillow(`pip install pillow`),用 LANCZOS 缩放,alpha 原样保留。
"""

import os
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("需要 Pillow: pip install pillow")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
MASTER = os.path.join(HERE, "tab-logo-master.png")
ICONS = os.path.join(REPO, "icons")
SIZES = [16, 32, 48, 128]


def main():
    if not os.path.exists(MASTER):
        sys.exit(f"找不到母图: {MASTER}")
    src = Image.open(MASTER).convert("RGBA")
    os.makedirs(ICONS, exist_ok=True)
    print(f"母图 {os.path.basename(MASTER)} {src.size[0]}x{src.size[1]} →")
    for px in SIZES:
        p = os.path.join(ICONS, f"icon{px}.png")
        src.resize((px, px), Image.LANCZOS).save(p)
        print("  icon", px, "→", p)


if __name__ == "__main__":
    main()
