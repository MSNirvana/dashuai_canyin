"""生成大帅餐饮小程序 tabBar 图标（81x81 PNG，超采样抗锯齿精修线稿）

精修要点：
1. 4x 超采样绘制（324x324），LANCZOS 缩到 81x81 —— 曲线/斜线平滑无锯齿
2. 圆头线帽（endpoint 圆点）+ curve joint —— 线条首尾圆润统一
3. 几何比例重新校准：视觉重心居中、留白均匀、三枚图标视觉重量一致
4. 普通态中性灰 / 选中态品牌红（白底 tabBar）
"""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'apps', 'mini', 'src', 'assets', 'tabbar')
os.makedirs(OUT, exist_ok=True)

SIZE = 81          # 目标尺寸
S = 4              # 超采样倍数
BIG = SIZE * S     # 324
NORMAL = (154, 158, 165, 255)   # #9a9ea5 中性灰
ACTIVE = (230, 57, 70, 255)     # #e63946 品牌红
LW = 5             # 81 坐标系下的线宽（4x 后为 20px）


def new_canvas():
    img = Image.new('RGBA', (BIG, BIG), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)


def s(v):
    """81 坐标 -> 324 坐标"""
    return v * S


def lw():
    return LW * S


def cap_line(d, pts, color):
    """带圆头线帽的折线：每段直线 + 端点圆点"""
    w = lw()
    r = w / 2
    for a, b in zip(pts, pts[1:]):
        d.line([s(a[0]), s(a[1]), s(b[0]), s(b[1])], fill=color, width=w)
    for p in (pts[0], pts[-1]):
        d.ellipse([s(p[0]) - r, s(p[1]) - r, s(p[0]) + r, s(p[1]) + r], fill=color)


def draw_home(d, color):
    """极简房子：人字屋顶 + 圆角房体 + 门洞"""
    # 屋顶（两段线，顶端圆头自然形成山尖）
    cap_line(d, [(12, 40), (40.5, 13), (69, 40)], color)
    # 房体（圆角矩形描边，仅下半段在屋檐线之下）
    d.rounded_rectangle([s(17), s(38), s(64), s(70)], radius=s(8), outline=color, width=lw())
    # 门（圆角填充）
    d.rounded_rectangle([s(33.5), s(52), s(47.5), s(70)], radius=s(4), fill=color)


def draw_create(d, color):
    """创作：圆角取景框 + 播放三角（重心偏移校正，视觉居中）"""
    d.rounded_rectangle([s(11), s(17), s(70), s(64)], radius=s(14), outline=color, width=lw())
    # 播放三角（填充，圆角由超采样自然平滑；整体右移 1.5 抵消视觉重心左偏）
    d.polygon([(s(33), s(28)), (s(33), s(53)), (s(56), s(40.5))], fill=color)


def draw_mine(d, color):
    """我的：圆头 + 弧形肩（肩线上收，留出底部呼吸空间）"""
    r = 13
    cx, cy = 40.5, 27
    d.ellipse([s(cx - r), s(cy - r), s(cx + r), s(cy + r)], outline=color, width=lw())
    # 肩部弧线（180°~360° 上半弧），两端圆头
    w = lw()
    half = w / 2
    box = [s(16), s(47), s(65), s(94)]
    d.arc(box, start=180, end=360, fill=color, width=w)
    # 弧线两端补圆头（180°端点 x=16, 360°端点 x=65，y 均为 47+ (94-47)/2 = 70.5）
    y_mid = 47 + (94 - 47) / 2
    for px in (16, 65):
        d.ellipse([s(px) - half, s(y_mid) - half, s(px) + half, s(y_mid) + half], fill=color)


ICONS = {'home': draw_home, 'create': draw_create, 'mine': draw_mine}

for name, fn in ICONS.items():
    for suffix, color in [('', NORMAL), ('-active', ACTIVE)]:
        img, d = new_canvas()
        fn(d, color)
        img = img.resize((SIZE, SIZE), Image.LANCZOS)
        path = os.path.join(OUT, f'{name}{suffix}.png')
        img.save(path)
        print(f'saved {path} ({os.path.getsize(path)} bytes)')
