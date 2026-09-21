#!/usr/bin/env python3
"""产物点检：确认源码里新写的中文文案真的进了小程序包。

★ 为什么不能用普通 grep：
  Taro 编译小程序时会把**所有非 ASCII 字符**编成 `\\uXXXX` 转义
  （中文、全角标点、`「」`、`；` 都一样）。
  直接 grep 原字符串必然全 MISS，然后会被误判成「文案没编译进去」。
  所以这里对被检串做两种形态（原样 / 全非 ASCII 转义）分别统计。

★★ 也不要用**函数名**去验「代码进包了」：terser 会改名，函数名本来就不在产物里，
  必然假阴性。要验「代码进去了」就验**用户能看到的文案**；要验「逻辑进去了」就验
  **行为**（真跑一次）。

用法（从仓库根调用即可；产物目录由 __file__ 定位，与当前 cwd 无关）：
  python3 apps/mini/scripts/check-dist-strings.py "文案一" "文案二"

反向用法（确认已经删掉的旧文案**不在**包里，同样重要）：
  python3 apps/mini/scripts/check-dist-strings.py --expect-absent "已删掉的旧文案"

退出码：有任何一条未达预期 = 1（可直接当发布前的闸门）；没给文案 = 2。
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
    expect_absent = False
    needles = []
    for arg in sys.argv[1:]:
        if arg in ('--expect-absent', '--absent'):
            expect_absent = True
        else:
            needles.append(arg)

    if not needles:
        print('用法: check-dist-strings.py [--expect-absent] "文案" ...')
        return 2

    files = []
    for dirpath, _dirnames, filenames in os.walk(ROOT):
        for name in filenames:
            if name.endswith(('.js', '.wxml', '.wxss', '.json')):
                files.append(os.path.join(dirpath, name))

    blobs = {}
    for path in files:
        blobs[path] = io.open(path, encoding='utf-8', errors='replace').read()

    total_bad = 0
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
        present = bool(hits)
        ok = (not present) if expect_absent else present
        if not ok:
            total_bad += 1
        if expect_absent:
            mark = 'ABSENT' if ok else 'MISS  '
        else:
            mark = 'HIT   ' if ok else 'MISS  '
        where = ''
        if hits:
            where = '  <- ' + ', '.join(
                os.path.relpath(p, ROOT) for p in hits[:3]
            ) + (f' (+{len(hits) - 3})' if len(hits) > 3 else '')
        print(f'{mark} {needle}{where}')

    print()
    kind = '未出现' if expect_absent else '命中'
    print(f'共 {len(needles)} 条，{kind} {len(needles) - total_bad} 条，未达预期 {total_bad} 条')
    return 1 if total_bad else 0


if __name__ == '__main__':
    sys.exit(main())
