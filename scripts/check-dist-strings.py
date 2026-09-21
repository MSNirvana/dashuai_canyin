#!/usr/bin/env python3
"""在**出包产物**里点检文案是否真的进了包（改代码 ≠ 进了包）。

用法：
    python3 scripts/check-dist-strings.py "字幕样式" "剪辑节奏" "硬切"
    python3 scripts/check-dist-strings.py --dir apps/mini/dist/weapp "文案"

判据：
- ★ 中文在产物里通常被**转义**成 `\\uXXXX`，所以要比对两种形态（原文 + 转义后的原文）。
  只搜原文会**漏报**，看到一片 MISS 就以为没打包进去，白忙一轮。
- ★★ **绝对不要用函数名去验**：terser 会改名，函数名本来就不在产物里 ⇒ 必然假阴性。
  要验「代码进去了」就验**用户能看到的文案**，要验「逻辑进去了」就验**行为**（跑一次）。
- 退出码：有任何一条未命中 = 1（可直接用在 CI / 手工发布前的闸门）。

反向用法（确认已经删掉的旧文案**不在**包里，同样重要）：
    python3 scripts/check-dist-strings.py --expect-absent "配音与字幕一起由云端合成"
"""
from __future__ import annotations

import io
import sys
from pathlib import Path

DEFAULT_DIR = "apps/mini/dist/weapp"


def parse_args(argv: list[str]) -> tuple[str, bool, list[str]]:
    target, expect_absent, words = DEFAULT_DIR, False, []
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg == "--dir":
            index += 1
            if index >= len(argv):
                raise SystemExit("--dir 后面要跟产物目录路径")
            target = argv[index]
        elif arg in ("--expect-absent", "--absent"):
            expect_absent = True
        else:
            words.append(arg)
        index += 1
    return target, expect_absent, words


def load_blob(target: str) -> str:
    root = Path(target)
    if not root.exists():
        raise SystemExit(f"找不到产物目录：{target}（先出包：apps/mini 下 npm run build:weapp:dev）")
    files = sorted(root.rglob("*.js")) + sorted(root.rglob("*.wxml")) + sorted(root.rglob("*.json"))
    if not files:
        raise SystemExit(f"{target} 下没有可扫描的产物文件")
    return "".join(io.open(path, encoding="utf-8", errors="ignore").read() for path in files)


def escaped(text: str) -> str:
    return "".join("\\u%04x" % ord(char) for char in text)


def main() -> int:
    target, expect_absent, words = parse_args(sys.argv[1:])
    if not words:
        raise SystemExit(__doc__)
    blob = load_blob(target)
    missed = 0
    print(f"扫描 {target}（{len(blob)} 字符）")
    for word in words:
        present = word in blob or escaped(word) in blob
        ok = (not present) if expect_absent else present
        if not ok:
            missed += 1
        label = "ABSENT" if expect_absent else "HIT   "
        print(f"{label if ok else 'MISS  '} {word}")
    total = len(words)
    kind = "未出现" if expect_absent else "命中"
    print(f"\n共 {total} 条，{kind} {total - missed}，未达预期 {missed}")
    return 1 if missed else 0


if __name__ == "__main__":
    sys.exit(main())
