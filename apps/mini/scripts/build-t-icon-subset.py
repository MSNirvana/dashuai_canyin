#!/usr/bin/env python3
"""把 TDesign 图标字体裁成「只含本项目用到的图标」的 woff，供小程序内嵌 base64。

为什么需要它：
  TDesign 的 `icon.wxss` 里 `@font-face` 只有**远程**地址
  （https://tdesign.gtimg.com/icon/0.4.3/fonts/t.woff 等），没有 base64。
  微信小程序**不能**从 CDN 加载字体（字体域不在 downloadFile 白名单就整条失败），
  于是真机上 `t-icon` 的元素在、占位在、字形是空的，且**不报错**；
  开发者工具能加载 ⇒ 典型的「本机/工具里好好的、真机上没有」。
  全量 t.woff 是 279KB，base64 后约 372KB，塞进 wxss 太重；
  本项目只用 16 个图标，裁完只有几 KB。

用法（只有新增图标名时才需要重跑）：
    cd apps/mini && python3 scripts/build-t-icon-subset.py
产物：
    src/assets/fonts/t-icon-subset.woff   内嵌用的字体
    src/assets/fonts/t-icon-subset.json   名字 → 码位清单（守护用）
依赖：
    pip3 install fonttools brotli
"""
import json
import pathlib
import re
import sys
import urllib.request

from fontTools import subset
from fontTools.ttLib import TTFont

MINI = pathlib.Path(__file__).resolve().parent.parent
ICON_WXSS = MINI / 'node_modules/tdesign-miniprogram/miniprogram_dist/icon/icon.wxss'
OUT_DIR = MINI / 'src/assets/fonts'
FONT_URL = 'https://tdesign.gtimg.com/icon/0.4.3/fonts/t.ttf'
CACHE = pathlib.Path('/tmp/t-icon-full.ttf')

# 本项目 src 里真正用到的图标名（`scripts/embed-t-icon-font.mjs` 会在构建时复核，
# 漏一个就报错，不会静默变成空白）
NAMES = [
    'book', 'call', 'camera', 'check', 'chevron-right', 'cloud', 'delete', 'film',
    'movie-clapper', 'order-list', 'rice', 'root-list', 'service', 'shop',
    'user-vip', 'wallet',
]


def load_full_font() -> pathlib.Path:
    if CACHE.exists() and CACHE.stat().st_size > 100_000:
        return CACHE
    print(f'==> 下载 {FONT_URL}')
    urllib.request.urlretrieve(FONT_URL, CACHE)
    return CACHE


def codepoints() -> dict[str, int]:
    css = ICON_WXSS.read_text(encoding='utf-8')
    table = {
        m.group(1): int(m.group(2), 16)
        for m in re.finditer(r"\.t-icon-([a-z0-9-]+):before\{content:'\\([0-9A-Fa-f]+)'", css)
    }
    missing = [n for n in NAMES if n not in table]
    if missing:
        sys.exit(f'✗ icon.wxss 里找不到这些图标名：{missing}')
    return {n: table[n] for n in NAMES}


def main() -> None:
    table = codepoints()
    src = load_full_font()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    font = TTFont(src)
    opts = subset.Options()
    opts.flavor = 'woff'
    opts.desubroutinize = True
    opts.drop_tables += ['GSUB', 'GPOS', 'GDEF', 'kern']
    opts.name_IDs = ['*']
    opts.notdef_outline = True
    sub = subset.Subsetter(options=opts)
    sub.populate(unicodes=list(table.values()))
    sub.subset(font)
    font.flavor = 'woff'

    out_woff = OUT_DIR / 't-icon-subset.woff'
    font.save(out_woff)
    (OUT_DIR / 't-icon-subset.json').write_text(
        json.dumps({
            '_comment': 'TDesign 图标（MIT）子集：只含本项目用到的字形。'
                        '生成脚本见 scripts/build-t-icon-subset.py；'
                        '码位来自 node_modules/.../icon/icon.wxss，与字体同版本 0.4.3。',
            'version': '0.4.3',
            'glyphs': table,
        }, ensure_ascii=False, indent=2, sort_keys=True) + '\n',
        encoding='utf-8',
    )

    print(f'✓ {out_woff.relative_to(MINI)}  {out_woff.stat().st_size} 字节 / {len(table)} 个字形')
    print(f'  base64 后约 {int(out_woff.stat().st_size * 4 / 3)} 字节')


if __name__ == '__main__':
    main()
