#!/usr/bin/env python3
r"""产物点检：确认源码里新写的中文文案真的进了小程序包。

★ 为什么不能用普通 grep：
  Taro 编译小程序时会把**所有非 ASCII 字符**编成 `\uXXXX` 转义
  （中文、全角标点、`「」`、`；` 都一样）。
  直接 grep 原字符串必然全 MISS，然后会被误判成「文案没编译进去」。
  所以这里对被检串做两种形态（原样 / 非 ASCII 转义）分别统计。

★★ 也不要用**函数名**去验「代码进包了」：terser 会改名，函数名本来就不在产物里，
  必然假阴性。要验「代码进去了」就验**用户能看到的文案**；要验「逻辑进去了」就验
  **行为**（真跑一次）。

★★ 转义还有**第二种方言**，只认一种就会假阴性：码点在 `0x80 ~ 0xFF` 之间的字符，
  构建可能编成**单字节** `\xb7`，而不是 `\u00b7`。典型受害者是 `·`(U+00B7)、
  `«`、`§`、`À`(拉丁字母带音符) —— 它们恰好常出现在中文文案里当分隔符。
  所以下面同时对「`\xXX` 短形态」和「`\uXXXX` 长形态」两种拼法做匹配，
  少拼一种就会把**已经进包**的文案报成 MISS。

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


def _escaped(s: str, short_form: bool) -> str:
    r"""把串里的非 ASCII 逐字转义。

    short_form=True 时，码点 < 0x100 的字符用单字节转义 `\xXX`（构建真的会这么编），
    否则一律用 `\uXXXX`。两种都要试，见文件头 ★★。
    """
    out = []
    for ch in s:
        c = ord(ch)
        if c < 128:
            out.append(ch)
        elif short_form and c < 0x100:
            out.append('\\x%02x' % c)
        else:
            out.append('\\u%04x' % c)
    return ''.join(out)


def escaped_variants(s: str):
    r"""该串在小程序包里可能的若干种等价形态（含原样），逐个拿去比对。

    ★ 不要只保留一种：同一个 `·` 在 `dist` 里就真的写成了 `\xb7`。
    """
    forms = [s, _escaped(s, True), _escaped(s, False)]
    seen = set()
    uniq = []
    for f in forms:
        if f not in seen:
            seen.add(f)
            uniq.append(f)
    return uniq


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
        hits = []
        for form in escaped_variants(needle):
            for path, blob in blobs.items():
                if form in blob:
                    hits.append(path)
        hits = sorted(set(hits))
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
