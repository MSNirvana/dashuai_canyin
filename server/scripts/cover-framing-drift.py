#!/usr/bin/env python
"""算出成片封面相对「本地裁好的底图」残留了多少缩放/平移 —— 用数字回答
「取景到底有没有被改」。

══ 为什么需要这个脚本（2026-09-24 第三轮返工）══
用户的原话是「**这个底图不是从视频抽出来的吗？为什么感觉还是有拉扯感，不应该啊**」。
用 PSNR 回答不了这个问题：标题是纯色描边大字、盖住画面一大块，
**即使取景完全一致也拿不到高分**，于是「取景被改」与「只是被标题盖住」在全图 PSNR 上长得一样。

本脚本把两个混淆源逐个消掉：
  1. **只比没有文字的下半幅**（默认 y ≥ 45%）—— 避开标题；
  2. 允许每个候选变换先做一次**逐通道线性拟合** b ≈ k·a + m —— 吸收模型的调色/提亮/压暗；
  3. 在 (缩放 s, 平移 dx, dy) 上搜索，看最佳匹配落在哪 —— 落在 (1, 0, 0) 就是取景没动。

══ 实测参照（同一源帧 outputs/subtitle-pos/frame-20s.jpg）══
  旧路径（把**未裁的 9:16 原帧**交给模型）：
      恒等 16.09 dB ／ 最佳 20.57 dB @ 缩放 1.022、平移 (+3, **+30**) px  ⇒ 取景被改了
  新路径（先把底图**本地裁成 3:4** 再交给模型）：
      恒等 21.20 dB ／ 最佳 23.02 dB @ 缩放 1.014、平移 (+1, -2) px    ⇒ 取景没动
  ★ 判据看的是**最佳匹配的参数**，不是分数本身：分数受调色影响，
    「30px 的纵向位移」才是用户所说「拉扯感」的客观对应物。

══ 用法 ══
  python3 scripts/cover-framing-drift.py <底图> <成品>
  底图 = `publish-cover:probe` 存下来的 `封面体检-<ts>-底图.jpg`
  成品 = 同一次的 `封面体检-<ts>.png`
  ⚠ 依赖 numpy（本机托管 venv `~/.workbuddy/binaries/python/envs/default` 里已有）。
  ⚠ 这是**诊断**脚本：不进 CI、不被守护脚本断言 —— 它要花钱出图才有意义。
"""
import subprocess
import sys

import numpy as np

W, H = 1080, 1440
BAND_Y0 = int(H * 0.45)  # 标题在顶部 ~30%，从 45% 往下开始是干净区
STEP = 4  # 采样步长（够用且快）


def load(path: str) -> np.ndarray:
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", path, "-vf", f"scale={W}:{H}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True,
        check=True,
    ).stdout
    return np.frombuffer(out, dtype=np.uint8).reshape(H, W, 3).astype(np.float32)


def band_mse(base: np.ndarray, cover: np.ndarray, s: float, dx: float, dy: float) -> float:
    cx, cy = W / 2, H / 2
    ys = np.arange(BAND_Y0, H, STEP)
    xs = np.arange(0, W, STEP)
    gy, gx = np.meshgrid(ys, xs, indexing="ij")
    sy = np.clip(np.rint(cy + (gy - cy) * s + dy).astype(np.int32), 0, H - 1)
    sx = np.clip(np.rint(cx + (gx - cx) * s + dx).astype(np.int32), 0, W - 1)
    a = cover[sy, sx]  # 候选变换后的 cover
    b = base[gy, gx]  # 底图
    # 逐通道线性拟合 b ≈ k*a + m，吸收模型的调色/提亮
    k = np.empty(3)
    m = np.empty(3)
    for c in range(3):
        av, bv = a[..., c].ravel(), b[..., c].ravel()
        A = np.vstack([av, np.ones_like(av)]).T
        sol, *_ = np.linalg.lstsq(A, bv, rcond=None)
        k[c], m[c] = sol
    resid = b - (a * k + m)
    return float(np.mean(resid**2))


def psnr(mse: float) -> float:
    return float("inf") if mse <= 0 else 10 * np.log10(255.0**2 / mse)


def main() -> None:
    if len(sys.argv) < 3:
        print(__doc__)
        raise SystemExit(2)
    base_path, cover_path = sys.argv[1], sys.argv[2]
    base, cover = load(base_path), load(cover_path)

    best = None
    for s in np.arange(0.94, 1.085, 0.01):
        for dx in range(-32, 33, 4):
            for dy in range(-32, 33, 4):
                mse = band_mse(base, cover, float(s), float(dx), float(dy))
                if best is None or mse < best[0]:
                    best = (mse, float(s), float(dx), float(dy))
    # 粗搜完再在最优附近细搜
    _, s0, dx0, dy0 = best
    for s in np.arange(s0 - 0.01, s0 + 0.0101, 0.002):
        for dx in range(int(dx0) - 4, int(dx0) + 5):
            for dy in range(int(dy0) - 4, int(dy0) + 5):
                mse = band_mse(base, cover, float(s), float(dx), float(dy))
                if mse < best[0]:
                    best = (mse, float(s), float(dx), float(dy))

    mse, s, dx, dy = best
    ident = band_mse(base, cover, 1.0, 0.0, 0.0)
    print("在下半幅（无文字区）上的二维对齐搜索：")
    print(f"  恒等变换（假设取景完全没动）: PSNR = {psnr(ident):.2f} dB")
    print(f"  最佳匹配                   : PSNR = {psnr(mse):.2f} dB   缩放 {s:.3f}  平移 ({dx:+.0f}, {dy:+.0f}) px")
    print()
    if abs(s - 1) <= 0.02 and abs(dx) <= 3 and abs(dy) <= 3:
        print("  ⇒ 最佳匹配就在恒等变换附近：**取景没有被改**，残余差异来自调色与重绘。")
    else:
        print("  ⇒ 最佳匹配明显偏离恒等变换：成品相对底图被**缩放/平移**过，取景确实被改了。")
        print("     先查底图是不是真的 3:4（`publish-cover:probe` 会报尺寸），再看提示词有没有")
        print("     丢掉「构图必须与参考图完全一致 / 绝不许改变取景」那两条。")


if __name__ == "__main__":
    main()
