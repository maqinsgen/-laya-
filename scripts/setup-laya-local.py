"""Create a workspace-only Laya environment and fetch public safetensors.

Run with Python 3.10+; no system Python packages are modified.
"""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import venv

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.cache' / 'laya'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skip-download', action='store_true', help='只安装依赖，不下载模型')
    args = parser.parse_args()
    if sys.version_info < (3, 10):
        raise SystemExit('Laya 需要 Python 3.10+；建议使用 Python 3.12 运行此脚本。')
    directory = CACHE / 'venv'
    python = directory / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    CACHE.mkdir(parents=True, exist_ok=True)
    if not python.exists():
        venv.EnvBuilder(with_pip=True).create(directory)
    subprocess.run([
        str(python), '-m', 'pip', 'install', '--disable-pip-version-check',
        '--index-url', 'https://pypi.org/simple', '--cache-dir', str(CACHE / 'pip'),
        'laya[serve]==0.3.9', 'transformers>=4.48,<5',
    ], check=True)
    frozen = subprocess.check_output([str(python), '-m', 'pip', 'freeze'], text=True)
    (CACHE / 'requirements.installed.txt').write_text(frozen, encoding='utf-8')
    if not args.skip_download:
        # Only the fixed public HF checkpoint files are fetched; no user state.
        subprocess.run([str(python), str(ROOT / 'scripts/serve-laya-local.py'), '--download-only'], check=True)
    print('隔离环境就绪。启动：')
    print('"%s" scripts/serve-laya-local.py' % python)


if __name__ == '__main__':
    main()
