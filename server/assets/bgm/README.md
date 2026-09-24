# 配乐曲库（BGM）

这个目录是**运行时数据**，不是源码。渲染时只按「风格 → 文件名」在这里找曲子。

## 契约

| 风格 | 文件 |
| --- | --- |
| `LIGHT` | `LIGHT.<ext>` |
| `UPBEAT` | `UPBEAT.<ext>` |
| `PREMIUM` | `PREMIUM.<ext>` |

- 扩展名白名单：`mp3 / m4a / aac / wav / flac / ogg / opus`（同一风格有多个时按此顺序取第一个）。
- 每个 `<风格>.json` 是**旁注元数据**（来源 / 提示词 / 时长 / 授权说明），渲染不读它，
  但 `<风格>.json` **不能**被当成曲子取到 —— `resolveBgmTrack()` 只认音频白名单。
- 目录可由环境变量 `BGM_LIBRARY_DIR` 覆盖；没配就按「模块相对 `../../assets/bgm`」解析，
  所以 `src/` 与 `dist/` 下都能跑。

## 两条硬约束

1. **曲子必须不比成片短**（≥ 65s 安全线）。
   `synthesis.ts::mixAudioTracks()` 用 `amix=duration=longest` 且只输出一条音频流，**不做循环**；
   比成片短的曲子会在中途静音，而且**不报错**。
   ⚠ 不要为了补齐而加 `-stream_loop -1`：混音输出会变成**单条无限流**，`-shortest` 没有有界流可比，
   渲染会**永久挂住**。要循环必须同时给 `-t <成片时长>`，那是另一笔改动。
2. **别手工删这里的东西**。删掉某个风格只是退回合成垫底（不会让出片失败），
   但那正是「配乐像嗡声不像曲子」这个老问题的成因。

## 重新生成

```bash
cd server
npm run bgm:generate -- --list                              # 先看现状
npm run bgm:generate -- --style=ALL --yes                   # 补齐缺口（已存在的会跳过）
npm run bgm:generate -- --style=LIGHT --yes --force         # 强制重造某一首
npm run bgm:generate -- --style=UPBEAT --asset=<assetId> --yes --project=<projectId>
                                                            # 只把**已生成好**的素材取回落盘（不再花生成额度）
npm run bgm:verify                                          # 守卫：三份风格清单是否仍同源
```

**生成消耗 ChatCut 额度**，所以脚本**默认 dry-run**，必须显式加 `--yes`。

## 当前曲目（服务器上实际内容）

| 风格 | 时长 | 大小 | 整轨响度 |
| --- | --- | --- | --- |
| LIGHT | 155.10s | 6.21 MB | −15.2 LUFS |
| UPBEAT | 188.59s | 7.55 MB | −14.0 LUFS |
| PREMIUM | 205.99s | 8.24 MB | −14.4 LUFS |

均为 mp3 48kHz 立体声 320kbps，来源 `chatcut:mureka-9`，无 ≥1.5s 静音段。

> ⚠ 授权以 **ChatCut 服务条款**为准 —— 商用前请核对当期条款并留档。
> 也正因如此，这些音频**不入 git**（仓库是 public，见根目录 `.gitignore` 里的说明）。
