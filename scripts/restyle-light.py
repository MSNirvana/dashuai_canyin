"""批量将大帅餐饮小程序从「深红黑渐变光晕」切到「红白简约扁平」

只做确定性 token / 渐变替换，不改 DOM 结构、不改选择器。
每个旧字符串在前一阶段已 grep 确认替换目标唯一。
"""
import glob
import re

ROOT = '/Users/gaoyunhong/WorkBuddy/2026-09-07-17-56-03/apps/mini/src'

# (旧, 新) 列表 —— 按出现频率高的先做
COMMON = [
    # ── 主操作按钮：红渐变 → 品牌红实色 ──
    ('background: linear-gradient(135deg, #ff6b6b 0%, #e63946 50%, #c1202c 100%);',
     'background: var(--td-brand-color);'),
    ('background: linear-gradient(135deg, #ff6b6b 0%, #e63946 100%);',
     'background: var(--td-brand-color);'),
    # ── 序号圆 / 角标类小元素：红渐变 → 品牌红实色 ──
    ('background: linear-gradient(135deg, #ff6b6b 0%, #e63946 100%);\n    color: #fff;',
     'background: var(--td-brand-color);\n    color: #fff;'),
    # ── 深色 footer 渐变（两个变体） → 白底毛玻璃 ──
    ('background: linear-gradient(180deg, rgba(15, 8, 8, 0) 0%, rgba(15, 8, 8, 0.95) 30%, #0f0808 100%);',
     'background: rgba(255, 255, 255, 0.94);\n    backdrop-filter: blur(20rpx);\n    border-top: 1rpx solid var(--td-component-border);'),
    ('background: linear-gradient(180deg, rgba(15, 8, 8, 0) 0%, rgba(15, 8, 8, 0.95) 20%, #0f0808 100%);',
     'background: rgba(255, 255, 255, 0.94);\n    backdrop-filter: blur(20rpx);\n    border-top: 1rpx solid var(--td-component-border);'),
    # ── 营销 recharge 余额卡：深红渐变 → 品牌红实色（仍红底白字大牌） ──
    ('background:\n      radial-gradient(circle at top right, rgba(244, 197, 66, 0.25) 0%, transparent 55%),\n      linear-gradient(135deg, #e63946 0%, #c1202c 100%);',
     'background: var(--td-brand-color);'),
    # ── 角标：亮金渐变 → 琥珀实色 ──
    ('background: linear-gradient(135deg, #ffd874 0%, #f4c542 100%);',
     'background: var(--ds-warning);'),
    # ── 进度条（mine storagefill 三色渐变）→ 品牌红实色 ──
    ('background: linear-gradient(90deg, #ff6b6b 0%, #e63946 60%, #f4c542 100%);',
     'background: var(--td-brand-color);'),
    # ── 存储卡 tag 半透白 → 浅灰 ──
    ('background: rgba(255, 255, 255, 0.08);\n    color: var(--td-text-color-secondary);',
     'background: #f2f3f5;\n    color: var(--td-text-color-secondary);'),
    # ── gold rgba 系列 → 琥珀色 token / 浅底 ──
    ('border: 1rpx solid rgba(244, 197, 66, 0.35);',
     'border: 1rpx solid #eddfc3;'),
    ('border: 1rpx solid rgba(244, 197, 66, 0.45);',
     'border: 1rpx solid #eddfc3;'),
    ('border: 1rpx solid rgba(244, 197, 66, 0.22);',
     'border: 1rpx solid #f3e6c8;'),
    ('border: 1rpx dashed rgba(244, 197, 66, 0.5);',
     'border: 1rpx dashed #eddfc3;'),
    ('background: rgba(244, 197, 66, 0.12);',
     'background: var(--ds-warning-soft);'),
    ('background: rgba(244, 197, 66, 0.1);',
     'background: var(--ds-warning-soft);'),
    ('background: rgba(244, 197, 66, 0.08);',
     'background: var(--ds-warning-soft);'),
    # ── compose premiumtip 多行 → 改用 token 拼接 ──
    ('background: rgba(244, 197, 66, 0.08);\n    border: 1rpx solid rgba(244, 197, 66, 0.35);',
     'background: var(--ds-warning-soft);\n    border: 1rpx solid #eddfc3;'),
    # ── mine 存储 fill 高占比 (tsx 内联) 不动（仅 scss 处理） ──
]

files = sorted(glob.glob(f'{ROOT}/pages/*/*.scss'))
for f in files:
    src = open(f, encoding='utf-8').read()
    new = src
    changes = []
    for old, repl in COMMON:
        if old in new:
            n = new.count(old)
            new = new.replace(old, repl)
            changes.append((n, old[:60]))
    if new != src:
        open(f, 'w', encoding='utf-8').write(new)
        print(f'✏  {f}  {sum(n for n,_ in changes)} 处')
        for n, snippet in changes:
            print(f'    · ×{n}  {snippet!r}…')
    else:
        print(f'   {f}  无变化')
