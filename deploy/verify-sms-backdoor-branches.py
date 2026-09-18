#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════
# deploy.sh 的「开发登录后门体检」分支守护
#
#   用法： python3 deploy/verify-sms-backdoor-branches.py
#
# 为什么需要：deploy.sh 里那段体检把闸门判定**又写了一遍**（bash 版），
#   与 server/src/auth/sms.ts::smsTestCodeConfig() 是两份实现。
#   两份实现在同一件事上各自演化，是典型的静默漂移源 ——
#   而这条闸门恰恰是「删了没有」的安全判据，措辞说错方向会误导运维。
#
#   ★ 本脚本已实打实抓到过两个缺陷（2026-09-18）：
#     ① 首分支原写 `[ -z CODE ] && [ -z PHONES ]`（两个都空才叫未启用），
#        与「码与名单必须同时非空才生效」不符 ⇒ 后门其实关着时会喊「已启用」；
#     ② 五行 `VAR="$(grep ...)"` 在 `set -euo pipefail` 下，`.env` 缺该键时
#        grep 返回 1 ⇒ 整条管道判失败 ⇒ 脚本**静默中止**（连报错都没有）。
#
# 依赖：python3（无需第三方库）、bash
# ═══════════════════════════════════════════════════════════════
import io
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
DEPLOY_SH = os.path.join(HERE, 'deploy.sh')

src = io.open(DEPLOY_SH, encoding='utf-8').read()

# 抽出体检块：从注释标题到第 3 步的 log 行之前
START = '# 开发登录后门体检（体验版测试期专用）——'
ENDMARK = 'log "[3/7]'
if src.count(START) != 1 or src.count(ENDMARK) != 1:
    sys.exit(f'!! 抽块失败：START×{src.count(START)} ENDMARK×{src.count(ENDMARK)}')
block = src[src.index(START): src.index(ENDMARK)]


def gate(node_env, code, phones, allow):
    """与 server/src/auth/sms.ts::smsTestCodeConfig() 同语义的参照实现（四道闸门）。"""
    if not re.fullmatch(r'\d{6}', code or ''):
        return 'OFF'                                    # ② 值形态
    if not [p for p in (phones or '').split(',') if p.strip()]:
        return 'OFF'                                    # ③ 白名单非空
    if node_env == 'production' and allow != 'true':
        return 'OFF'                                    # ① 环境（破例须字面 'true'）
    return 'ON'


CASES = [
    ('两个都空（线上应保持）',      'production',  '',       '',            '',     '未启用'),
    ('码填了、名单空 → 闸门是关的', 'production',  '123456', '',            'true', '未启用'),
    ('名单填了、码空 → 闸门是关的', 'production',  '',       '13700000001', 'true', '未启用'),
    ('生产 + 配了码但没开破例',     'production',  '123456', '13700000001', '',     '整块失效'),
    ('生产 + 开了破例',             'production',  '123456', '13700000001', 'true', '已启用'),
    ('生产 + 破例写成 TRUE（不算）', 'production', '123456', '13700000001', 'TRUE', '整块失效'),
    ('非生产（本机）',              'development', '123456', '13700000001', '',     '已配置'),
]


def run(node_env, code, phones, allow):
    d = tempfile.mkdtemp()
    lines = []
    if code:
        lines.append(f'SMS_TEST_CODE="{code}"')
    if phones:
        lines.append(f'SMS_TEST_CODE_PHONES="{phones}"')
    if allow:
        lines.append(f'SMS_TEST_CODE_ALLOW_PROD="{allow}"')
    io.open(os.path.join(d, '.env'), 'w', encoding='utf-8').write('\n'.join(lines) + '\n')

    # 只喂体检块，前置的 warn/echo 用替身；SERVER_DIR 指向临时目录
    script = (
        'set -euo pipefail\n'
        f'SERVER_DIR={d}\n'
        f'ENV_NODE={node_env}\n'
        'warn() { printf "WARN|%s\\n" "$*"; }\n'
        'echo() { printf "%s\\n" "$*"; }\n'
        + block
    )
    # LANG 固定为 C.UTF-8：让本脚本的结论与运行机器的 locale 无关
    env = dict(os.environ, LANG='C.UTF-8', LC_ALL='C.UTF-8')
    r = subprocess.run(['bash', '-c', script], capture_output=True, env=env)
    out = (r.stdout + r.stderr).decode('utf-8', errors='replace').strip()
    return r.returncode, out


def main():
    ok = 0
    for name, ne, code, phones, allow, expect in CASES:
        rc, out = run(ne, code, phones, allow)
        says_on = '已启用' in out
        truth = gate(ne, code, phones, allow) == 'ON'
        # 核心一致性：**生产环境**下，脚本喊没喊「已启用」必须等于闸门真实状态
        # （非生产刻意只说"已配置" —— 那条 ⚠⚠ 是给线上看的）
        consistent = (rc == 0 and expect in out) and (says_on == truth if ne == 'production' else True)
        mark = '✓' if consistent else '✗'
        if consistent:
            ok += 1
        print(f'  {mark} {name}   [闸门={"ON" if truth else "OFF"} / 脚本说"已启用"={says_on}]')
        if not consistent:
            for ln in out.splitlines():
                print(f'       {ln}')
            if rc != 0:
                print(f'       !! 退出码 {rc}')

    print(f'\n{ok}/{len(CASES)} 分支符合预期（含「脚本措辞 == 闸门真实状态」一致性）')
    sys.exit(0 if ok == len(CASES) else 1)


if __name__ == '__main__':
    main()
