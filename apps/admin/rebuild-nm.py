#!/usr/bin/env python3
"""从 npm cacache 缓存按 package-lock.json 重建 node_modules（绕开 npm reify）
直接用 lockfile 每个包的 integrity 定位 content-v2 里的 tarball 并解包。"""
import base64
import hashlib
import json
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path('/Users/gaoyunhong/WorkBuddy/2026-09-07-17-56-03/apps/admin')
CACHES = [
    ROOT / '.npm-cache' / '_cacache',
    Path.home() / '.npm' / '_cacache',
]
LOCK = ROOT / 'package-lock.json'

def integrity_to_path(integ: str):
    algo, b64 = integ.split('-', 1)
    hexs = base64.b64decode(b64).hex()
    rel = Path(algo) / hexs[:2] / hexs[2:4] / hexs[4:]
    for c in CACHES:
        p = c / 'content-v2' / rel
        if p.exists():
            return p
    return None

def download_tarball(url: str, integ: str) -> Path:
    """缓存未命中时用 curl 下载并校验 integrity"""
    tmp = Path(tempfile.mkstemp(suffix='.tgz')[1])
    r = subprocess.run(['curl', '-sL', '-o', str(tmp), url], capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f'curl failed: {url}')
    algo, b64 = integ.split('-', 1)
    digest = hashlib.new(algo, tmp.read_bytes()).digest()
    if base64.b64encode(digest).decode() != b64:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f'integrity mismatch: {url}')
    return tmp

def main():
    lock = json.loads(LOCK.read_text())
    packages = lock.get('packages', {})
    done, skipped, downloaded, missing = 0, 0, 0, []
    this_os = 'darwin' if sys.platform == 'darwin' else 'linux'
    this_cpu = 'arm64' if platform.machine() == 'arm64' else 'x64'

    def field_matches(v, want: str) -> bool:
        """os/cpu 字段可能是字符串、'|' 分隔字符串或数组"""
        if v is None:
            return True
        if isinstance(v, list):
            return want in v
        return want in str(v).split('|')

    for key, meta in packages.items():
        if not key or not meta.get('resolved'):
            continue
        # 平台不匹配的 optional 二进制（npm 本来也不会装）
        if not field_matches(meta.get('os'), this_os) or not field_matches(meta.get('cpu'), this_cpu):
            skipped += 1
            continue
        integ = meta.get('integrity')
        if not integ:
            missing.append((key, 'no-integrity'))
            continue
        src = integrity_to_path(integ)
        tmp_downloaded = False
        if src is None:
            try:
                src = download_tarball(meta['resolved'], integ)
                tmp_downloaded = True
                downloaded += 1
            except Exception as e:
                missing.append((key, str(e)))
                continue
        dest = ROOT / key
        if dest.exists():
            shutil.rmtree(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        with tarfile.open(src, 'r:gz') as tf:
            members = [m for m in tf.getmembers()
                       if not m.name.startswith('/') and '..' not in m.name.split('/')]
            tf.extractall(dest.parent, members=members, filter='data')
        # tarball 根目录：多数是 package/，@types 系列是「react v18.3」这类名字 —— 取唯一顶层目录改名
        roots = sorted({m.name.split('/')[0] for m in members if '/' in m.name})
        if len(roots) == 1:
            extracted = dest.parent / roots[0]
            if extracted.exists() and extracted != dest:
                extracted.rename(dest)
        elif (dest.parent / 'package').exists():
            (dest.parent / 'package').rename(dest)
        if tmp_downloaded:
            Path(src).unlink(missing_ok=True)
        done += 1

    print(f'extracted: {done} (downloaded: {downloaded}), skipped(platform-optional): {skipped}, missing: {len(missing)}')
    for k, why in missing[:15]:
        print('  MISS', k, why)
    sys.exit(1 if missing else 0)

if __name__ == '__main__':
    main()
