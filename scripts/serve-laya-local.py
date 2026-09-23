"""Run the official Laya HTTP surface on loopback with a fixed offline model."""
import argparse
import os

from laya_local_runtime import LocalMultilingualRouter, load_local_agent, model_path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--download-only', action='store_true', help='仅下载固定版本公开 multilingual 权重')
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--device', choices=['cpu', 'mps', 'cuda'], default='cpu')
    parser.add_argument('--threads', type=int, default=4)
    args = parser.parse_args()
    if args.download_only:
        print('公开模型已保存：%s' % model_path(download=True))
        return
    if not 1024 <= args.port <= 65535:
        parser.error('端口必须为 1024 至 65535。')
    # No --host option: never expose an unauthenticated classifier to the LAN.
    os.environ['LAYA_HOST'] = '127.0.0.1'
    os.environ['LAYA_DEVICE'] = args.device
    agent = load_local_agent(args.device, args.threads)
    from laya.serve import create_app
    import uvicorn
    app = create_app(router=LocalMultilingualRouter(agent))
    print('离线 multilingual 服务：http://127.0.0.1:%d/v1/systemone' % args.port)
    print('此实验模型的结果需要人工确认；Ctrl+C 停止。')
    uvicorn.run(app, host='127.0.0.1', port=args.port, workers=1, access_log=False)


if __name__ == '__main__':
    try:
        main()
    except ModuleNotFoundError:
        raise SystemExit('Laya 依赖尚未安装。先用 Python 3.10+ 运行 scripts/setup-laya-local.py，再用 .cache/laya/venv 内的 Python 启动。')
    except (RuntimeError, OSError) as error:
        raise SystemExit('Laya 本地服务未启动：%s\n部署步骤见 LAYA_LOCAL.md。' % error)
