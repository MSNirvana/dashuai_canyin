#!/usr/bin/env python3
r"""自建拍摄层的三个图标（切换镜头 / 补光开 / 补光关）—— 白描，透明底。

★ 为什么要有这个脚本：这三个图标是**画出来的**，不是设计师给的切图。
  把生成器留在仓库里，以后要改粗细 / 换形状时能重跑，而不是拿一个来路不明的 PNG 去覆盖。

★ 为什么不用字体图标 / TDesign 的 t-icon：
  它们都要放进 `<cover-view>` 里（那一层是盖在原生 `<camera>` 上的），而 cover-view
  **只允许嵌套 cover-view 与 cover-image**，别的一律渲染不出来。所以只能用图片资源。

★ 输出：`src/assets/shotcam/*.png`，由页面 TSX `import` 进来（同 `src/assets/logo.png` 的用法）。
  ⇒ 构建时走 webpack 的图片规则。**必须关掉 base64 内联**（见 `config/index.ts` 的
  `mini.imageUrlLoaderOption.limit = 0`）：<cover-image> 的 src 官方只声明支持
  「临时路径 / 网络地址 / 云文件ID」，没有列 data URL。

用法（需要 Pillow；本机可用的解释器见下）：
  /Users/gaoyunhong/.workbuddy/binaries/python/versions/3.13.12/bin/python3 \
      apps/mini/scripts/gen-shotcam-icons.py
  或（系统 python3 里装了 Pillow 的话）：
  python3 apps/mini/scripts/gen-shotcam-icons.py

★ 画完**一定要看一眼**（脚本会同时输出一张 `_preview.png`）：图标这种东西，
  「生成成功、rc=0、文件非空」全都不能说明它长得对。
"""
import math
import os
import sys

from PIL import Image, ImageDraw

# 画布边长（像素）。图标显示尺寸约 40rpx ≈ 20pt，120px 在 3x 屏上也够清楚。
SIZE = 120
# 超采样倍数：先在 8 倍画布上画，再缩下来，边缘才不会有锯齿。
SS = 8
W = SIZE * SS
WHITE = (255, 255, 255, 255)
CLEAR = (0, 0, 0, 0)

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'assets', 'shotcam')


def new_canvas() -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new('RGBA', (W, W), CLEAR)
    return img, ImageDraw.Draw(img)


def save(img: Image.Image, name: str) -> str:
    out = img.resize((SIZE, SIZE), Image.LANCZOS)
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.normpath(os.path.join(OUT_DIR, name))
    out.save(path, 'PNG', optimize=True)
    print(f'  ✓ {name}  {os.path.getsize(path)} B')
    return path


def stroke(frac: float) -> int:
    """把「相对画布的比例」换算成超采样画布上的笔画粗细。"""
    return max(1, int(round(frac * W)))


def arc_arrow(draw: ImageDraw.ImageDraw, radius_frac: float, a0: float, a1: float,
              width_frac: float, head_frac: float) -> None:
    """画一段圆弧，并在 a1 那一端补一个三角形的箭头（切线方向）。

    PIL 的角度是「0° 在 3 点钟方向、顺时针增大」（因为 y 轴朝下），下面全部按这个来。
    """
    cx = cy = W / 2
    r = radius_frac * W
    w = stroke(width_frac)
    box = (cx - r, cy - r, cx + r, cy + r)
    draw.arc(box, a0, a1, fill=WHITE, width=w)

    # 箭头：尖端沿切线再往前探一点，底边垂直于切线
    th = math.radians(a1)
    px, py = cx + r * math.cos(th), cy + r * math.sin(th)
    tx, ty = -math.sin(th), math.cos(th)          # a1 端的行进方向（角度增大方向）
    nx, ny = -ty, tx                              # 法线
    L = head_frac * W
    tip = (px + tx * L * 0.75, py + ty * L * 0.75)
    # ★ 底边半宽要**小于**箭头长度的一半（这里 0.72·w vs 0.5·L），否则箭头会胖成一个球，
    #   小尺寸下整圈看起来像两个团子而不是箭头。
    b1 = (px - tx * L * 0.25 + nx * w * 0.72, py - ty * L * 0.25 + ny * w * 0.72)
    b2 = (px - tx * L * 0.25 - nx * w * 0.72, py - ty * L * 0.25 - ny * w * 0.72)
    draw.polygon([tip, b1, b2], fill=WHITE)


def bolt_points() -> list[tuple[float, float]]:
    """闪电的六边形轮廓（归一化坐标，y 朝下）。就是「补光」那个闪电。"""
    pts = [
        (0.615, 0.045),   # 上尖
        (0.215, 0.575),   # 左上长边落点
        (0.435, 0.575),   # 中间台阶（向右）
        (0.335, 0.955),   # 下尖
        (0.785, 0.405),   # 右下长边落点
        (0.555, 0.405),   # 中间台阶（向左）
    ]
    return [(x * W, y * W) for x, y in pts]


def icon_switch() -> Image.Image:
    """切换镜头：环形双箭头（旋转符号）。摄像头语境下就是「前/后摄切换」。"""
    img, d = new_canvas()
    r = 0.300
    w = 0.105
    head = 0.200
    # 上面一段 195°→345°，下面一段 15°→165°，两个缺口留在左右两侧
    arc_arrow(d, r, 195, 345, w, head)
    arc_arrow(d, r, 15, 165, w, head)
    return img


def icon_flash(on: bool) -> Image.Image:
    """补光：**实心**闪电 = 开 / **空心**闪电 = 关。

    ★ 这里刻意**没用**「闪电 + 斜杠」那套：斜杠要在闪电上切一道透明缺口，
      缺口窄了小尺寸下看不见、宽了闪电就断成两块。而「实心 = 选中 / 空心 = 未选中」
      是全平台通行的约定，24px 下也分得清。
    """
    img, d = new_canvas()
    if on:
        d.polygon(bolt_points(), fill=WHITE)
    else:
        d.polygon(bolt_points(), outline=WHITE, width=stroke(0.085))
    return img


def preview(paths: list[str]) -> None:
    """拼一张验收图：深色底 + 三档尺寸，模拟真实按钮上的观感。"""
    bg = (20, 21, 24, 255)
    cell = 96
    canvas = Image.new('RGBA', (cell * len(paths), 200), bg)
    d = ImageDraw.Draw(canvas)
    for i, p in enumerate(paths):
        icon = Image.open(p).convert('RGBA')
        for row, size in enumerate((64, 40, 26)):
            small = icon.resize((size, size), Image.LANCZOS)
            x = i * cell + (cell - size) // 2
            y = 24 + row * 52
            # 顺便画上按钮底色，确认白图标压在半透明深底上的观感
            d.rounded_rectangle([x - 8, y - 8, x + size + 8, y + size + 8], radius=14,
                                fill=(0, 0, 0, 107))
            canvas.alpha_composite(small, (x, y))
    out = os.path.normpath(os.path.join(OUT_DIR, '_preview.png'))
    canvas.save(out)
    print(f'  ✓ 预览图 {out}')


def main() -> int:
    print(f'输出目录 {os.path.normpath(OUT_DIR)}')
    paths = [
        save(icon_switch(), 'switch-camera.png'),
        save(icon_flash(True), 'flash-on.png'),
        save(icon_flash(False), 'flash-off.png'),
    ]
    preview(paths)
    return 0


if __name__ == '__main__':
    sys.exit(main())
