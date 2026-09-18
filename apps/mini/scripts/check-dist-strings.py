#!/usr/bin/env python3
"""产物点检：确认源码里新写的中文文案真的进了小程序包。

★ 为什么不能用普通 grep：
  Taro 编译小程序时会把**所有非 ASCII 字符**编成 `\\uXXXX` 转义
  （中文、全角标点、`「」`、`；` 都一样）。
  直接 grep 原字符串必然全 MISS，然后会被误判成「文案没编译进去」。
  所以这里对被检串做两种形态（原样 / 全非 ASCII 转义）分别统计。

用法：
  python3 scripts/check-dist-strings.py "文案一" "文案二" ...
"""
import io
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'dist', 'weapp')


def escaped(s: str) -> str:
    out = []
    for ch in s:
        if ord(ch) < 128:
            out.append(ch)
        else:
            out.append('\\u%04x' % ord(ch))
    return ''.join(out)


def main() -> int:
    needles = sys.argv[1:]
    if not needles:
        print('用法: check-dist-strings.py "文案" ...')
        return 2

    files = []
    for dirpath, _dirnames, filenames in os.walk(ROOT):
        for name in filenames:
            if name.endswith(('.js', '.wxml', '.wxss', '.json')):
                files.append(os.path.join(dirpath, name))

    blobs = {}
    for path in files:
        blobs[path] = io.open(path, encoding='utf-8', errors='replace').read()

    total_miss = 0
    for needle in needles:
        raw_hits = []
        esc_hits = []
        esc = escaped(needle)
        for path, blob in blobs.items():
            if needle in blob:
                raw_hits.append(path)
            if esc != needle and esc in blob:
                esc_hits.append(path)
        hits = raw_hits + esc_hits
        mark = 'HIT ' if hits else 'MISS'
        if not hits:
            total_miss += 1
        where = ''
        if hits:
            where = '  <- ' + ', '.join(
                os.path.relpath(p, ROOT) for p in hits[:3]
            ) + (f' (+{len(hits) - 3})' if len(hits) > 3 else '')
        print(f'{mark} {needle}{where}')

    print()
    print(f'共 {len(needles)} 条，未命中 {total_miss} 条')
    return 1 if total_miss else 0


if __name__ == '__main__':
    sys.exit(main())
