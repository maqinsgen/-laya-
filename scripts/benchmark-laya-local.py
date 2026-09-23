"""Offline, sequential Laya CPU/MPS benchmark using synthetic app-shaped requests.

Run each device in a separate process. No chat database, account, key, HTTP server,
or network is accessed. --self-test needs only the Python standard library.
"""
import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import re
import statistics
import sys
import time

from laya_local_runtime import (
    CACHE, LAYA_VERSION, MODEL_REPO, MODEL_REVISION, ROOT,
    LocalMultilingualRouter, load_local_agent,
)

try:
    import resource
except ImportError:  # Windows does not expose getrusage through the stdlib.
    resource = None

SMOKE_FILE = Path(__file__).with_name('smoke-laya-local.py')
APP_FILE = ROOT / 'src' / 'shared' / 'todoDecision.ts'
USER_CONTEXT = '项目交付与研究'
STATE_TEMPLATE = '方向：收到\n关注：%s\n偏好：\n消息：%s'


def load_fixtures():
    spec = importlib.util.spec_from_file_location('notewake_laya_synthetic_smoke', SMOKE_FILE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def app_contract(smoke):
    """Fail closed if the small TS request builder changes; never guess its shape."""
    source = APP_FILE.read_text(encoding='utf-8')
    criteria_match = re.search(r'const layaCriteria = \{(.*?)\n\}', source, re.S)
    builder_match = re.search(
        r'export function buildLayaDecisionRequest\(.*?\n\}', source, re.S)
    if not criteria_match or not builder_match:
        raise ValueError('找不到应用 Laya 请求定义；请更新 benchmark 请求契约。')
    criteria = dict(re.findall(r"(\w+): '([^']*)'", criteria_match.group(1)))
    builder = builder_match.group(0)
    instruction = re.search(r"instructions: '([^']*)', criteria: layaCriteria", builder)
    required = [
        "const userContext = limitUtf8(String(settings.personalContext || '').trim(), 60)",
        "const direction = message.direction === 'incoming' ? '收到' : message.direction === 'outgoing' ? '用户发出' : '方向未知'",
        r'const state = `方向：${direction}\n关注：${userContext}\n偏好：${feedback}\n消息：${message.text}`',
        'const overBudget = new TextEncoder().encode(state).length > TODO_LAYA_STATE_MAX_BYTES',
    ]
    questions = {'value': {'type': 'choice', 'instructions': instruction.group(1) if instruction else '',
                           'criteria': criteria}}
    limits = {}
    for name in ['TODO_LAYA_BATCH_SIZE', 'TODO_LAYA_MESSAGE_MAX_BYTES', 'TODO_LAYA_STATE_MAX_BYTES']:
        match = re.search(r'export const %s = (\d+)\b' % name, source)
        limits[name] = int(match.group(1)) if match else None
    if (questions != smoke.QUESTION or limits != {'TODO_LAYA_BATCH_SIZE': 1,
            'TODO_LAYA_MESSAGE_MAX_BYTES': 480, 'TODO_LAYA_STATE_MAX_BYTES': 640}
            or any(fragment not in builder for fragment in required)):
        raise ValueError('应用 Laya 请求已变更；请先同步 benchmark，避免使用过时请求测量。')
    if len(USER_CONTEXT.encode('utf-8')) > 60:
        raise ValueError('合成用户关注超过应用预算。')
    return {'source': 'src/shared/todoDecision.ts',
            'source_sha256': hashlib.sha256(source.encode('utf-8')).hexdigest(),
            'direction': 'incoming', 'personal_context': USER_CONTEXT,
            'matching_feedback': [], 'questions': questions, 'limits': limits,
            'state_template': STATE_TEMPLATE.replace('%s', '{personal_context}', 1).replace('%s', '{message}', 1)}


def make_requests(smoke, contract):
    requests = []
    for name, text, expected in smoke.FIXTURES:
        state = STATE_TEMPLATE % (USER_CONTEXT, text)
        if len(text.encode('utf-8')) > 480 or len(state.encode('utf-8')) > 640:
            raise ValueError('合成样本超出应用预算：%s' % name)
        if expected not in contract['questions']['value']['criteria']:
            raise ValueError('合成样本包含未知预期分类：%s' % name)
        requests.append({'case': name, 'expected': expected, 'state': state,
                         'state_bytes': len(state.encode('utf-8')),
                         'questions': contract['questions']})
    if len(requests) < 12 or len({item['case'] for item in requests}) != len(requests):
        raise ValueError('至少需要 12 个名称唯一的合成样本。')
    return requests


def percentile(values, fraction):
    """Linear interpolation, equivalent to the common inclusive percentile."""
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    low, high = math.floor(position), math.ceil(position)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def latency_summary(rows, wall_ms):
    values = [row['latency_ms'] for row in rows]
    if not values or not math.isfinite(wall_ms) or wall_ms <= 0:
        raise ValueError('统计需要非空样本和有效耗时。')
    if any(not math.isfinite(value) or value <= 0 for value in values):
        raise ValueError('推理耗时必须为有限正数。')
    return {'requests': len(values), 'wall_ms': wall_ms,
            'min_ms': min(values), 'mean_ms': statistics.mean(values),
            'p50_ms': percentile(values, .5), 'p95_ms': percentile(values, .95),
            'max_ms': max(values),
            'throughput_messages_per_second': len(values) * 1000 / wall_ms}


def resource_snapshot(torch=None, device='cpu'):
    result = {'process_peak_rss_bytes': None, 'ru_maxrss_native': None,
              'ru_maxrss_native_unit': None, 'mps_allocated_bytes': None,
              'mps_driver_allocated_bytes': None}
    if resource is not None:
        native = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        # macOS reports bytes; Linux reports KiB. Leave other platforms unscaled.
        unit = 'bytes' if sys.platform == 'darwin' else 'KiB' if sys.platform.startswith('linux') else 'platform-dependent'
        result.update(ru_maxrss_native=native, ru_maxrss_native_unit=unit,
                      process_peak_rss_bytes=native if unit == 'bytes' else native * 1024 if unit == 'KiB' else None)
    if torch is not None and device == 'mps':
        for field, function in [('mps_allocated_bytes', 'current_allocated_memory'),
                                ('mps_driver_allocated_bytes', 'driver_allocated_memory')]:
            try:
                result[field] = int(getattr(torch.mps, function)())
            except (AttributeError, RuntimeError) as error:
                result[field + '_unavailable'] = str(error)
    return result


def synchronize(torch, device):
    if device == 'mps':
        torch.mps.synchronize()


def checked_answer(smoke, response):
    if not isinstance(response, dict) or not isinstance(response.get('answers'), dict):
        raise ValueError('模型返回格式无效。')
    answer = response['answers'].get('value')
    if not isinstance(answer, dict):
        raise ValueError('模型未返回 value 答案。')
    smoke.check_answer(answer, smoke.CRITERIA)
    usage = response.get('usage')
    tokens = usage.get('input_tokens') if isinstance(usage, dict) else None
    if isinstance(tokens, bool) or not isinstance(tokens, int) or tokens < 0:
        raise ValueError('模型未返回有效 input_tokens。')
    return answer, tokens


def make_report(contract, requests, rows, round_summaries, cold_load_ms, snapshots, environment):
    first_rows = [row for row in rows if row['round'] == 1]
    warm_rows = [row for row in rows if row['round'] > 1]
    warm_wall_ms = sum(item['wall_ms'] for item in round_summaries[1:])
    return {
        'schema_version': 1, 'synthetic_only': True,
        'created_at_utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'model': MODEL_REPO, 'revision': MODEL_REVISION, 'laya': LAYA_VERSION,
        'environment': environment, 'request_contract': contract,
        'fixture_count': len(requests), 'round_count': len(round_summaries),
        'cold_load_ms': cold_load_ms, 'first_request_ms': first_rows[0]['latency_ms'],
        'first_round': round_summaries[0],
        'warm': latency_summary(warm_rows, warm_wall_ms), 'rounds': round_summaries,
        'resources': snapshots, 'results': rows,
        'measurement_notes': [
            'One cached model load per fresh process; cold_load_ms includes imports, load and device synchronization. OS file cache is not flushed.',
            'Sequential single-message calls use the app question and state format, empty learned feedback, and synthetic incoming messages only.',
            'Latency includes the local budget guard and prediction; MPS is synchronized before and after each timed call. HTTP, Electron and chat retrieval are excluded.',
            'Round 1 has no prior inference warmup. Warm p50/p95 combine rounds 2 onward using linear interpolation.',
            'Throughput uses each measured loop wall time including result validation; resource snapshots are outside loop timing.',
            'ru_maxrss is the entire process lifetime high-water mark, not model-only memory. MPS allocations are synchronized snapshots, not measured peaks.',
            'Synthetic expected labels and raw answers are diagnostic only; this small set does not estimate production accuracy or calibrate confidence.',
        ],
    }


def validate_report(report):
    if report.get('schema_version') != 1 or report.get('synthetic_only') is not True:
        raise ValueError('报告 schema 无效。')
    fixtures, rounds = report['fixture_count'], report['round_count']
    if fixtures < 12 or rounds < 2 or len(report['results']) != fixtures * rounds:
        raise ValueError('报告样本数不匹配。')
    if len(report['rounds']) != rounds or report['warm']['requests'] != fixtures * (rounds - 1):
        raise ValueError('报告轮数或 warm 数量不匹配。')
    for key in ['cold_load_ms', 'first_request_ms']:
        if not math.isfinite(report[key]) or report[key] <= 0:
            raise ValueError('报告耗时无效。')
    for index, summary in enumerate(report['rounds'], 1):
        if summary.get('round') != index or summary['requests'] != fixtures:
            raise ValueError('报告逐轮统计不完整。')
        rows = [row for row in report['results'] if row['round'] == index]
        if latency_summary(rows, summary['wall_ms']) != {key: value for key, value in summary.items() if key != 'round'}:
            raise ValueError('报告统计与逐条结果不符。')
    if report['first_round'] != report['rounds'][0]:
        raise ValueError('报告首轮统计不一致。')
    expected_warm = latency_summary([row for row in report['results'] if row['round'] > 1],
                                    sum(item['wall_ms'] for item in report['rounds'][1:]))
    if report['warm'] != expected_warm:
        raise ValueError('报告 warm 统计不一致。')
    json.dumps(report, ensure_ascii=False, allow_nan=False)


def self_test():
    smoke = load_fixtures()
    contract = app_contract(smoke)
    requests = make_requests(smoke, contract)
    assert all('\n偏好：\n消息：' in request['state'] for request in requests)
    assert percentile([1, 2, 3, 4], .5) == 2.5
    assert abs(percentile([1, 2, 3, 4], .95) - 3.85) < 1e-12
    assert percentile([7], .95) == 7 and percentile([], .5) is None
    rows, summaries = [], []
    for round_number in range(1, 4):
        round_rows = [{'round': round_number, 'case': request['case'],
                       'latency_ms': float(index + round_number)}
                      for index, request in enumerate(requests, 1)]
        rows.extend(round_rows)
        summaries.append({'round': round_number, **latency_summary(round_rows, 1000.0)})
    report = make_report(contract, requests, rows, summaries, 100.0,
                         {'before_load': resource_snapshot()}, {'device_requested': 'cpu', 'self_test': True})
    validate_report(report)
    assert report['warm']['requests'] == 2 * len(requests)
    assert report['warm']['throughput_messages_per_second'] == len(requests)
    valid = {'answers': {'value': {'type': 'choice', 'choice': 'action', 'confidence': .5,
              'probabilities': {'action': .7, 'important': .1, 'noise': .1, 'uncertain': .1}}},
             'usage': {'input_tokens': 50}}
    checked_answer(smoke, valid)
    bad_report = json.loads(json.dumps(report))
    bad_report['warm']['p95_ms'] += 1
    bad_inputs = [(validate_report, bad_report),
                  (lambda value: checked_answer(smoke, value), {**valid, 'usage': {'input_tokens': True}}),
                  (lambda value: latency_summary(value, 1), [{'latency_ms': float('nan')}])]
    for check, value in bad_inputs:
        try:
            check(value)
        except ValueError:
            pass
        else:
            raise AssertionError('无效统计或 schema 被接受。')
    assert 'torch' not in sys.modules and 'laya' not in sys.modules
    print('benchmark self-test 通过：%d 个应用格式合成请求、分位数、吞吐量及报告 schema；未加载 Torch 或真实模型。' % len(requests))


def run(args):
    smoke = load_fixtures()
    contract = app_contract(smoke)
    requests = make_requests(smoke, contract)
    snapshots = {'before_load': resource_snapshot()}
    started = time.perf_counter()
    import torch
    if args.device == 'mps' and not torch.backends.mps.is_available():
        raise RuntimeError('本机 Torch 未提供可用 MPS；请单独使用 --device cpu，不会自动切换设备。')
    runtime = LocalMultilingualRouter(load_local_agent(args.device, threads=args.threads))
    synchronize(torch, args.device)
    cold_load_ms = (time.perf_counter() - started) * 1000
    actual_device = str(runtime.agent.device)
    if actual_device.split(':')[0] != args.device:
        raise RuntimeError('模型实际设备与指定设备不一致：%s' % actual_device)
    snapshots['after_load'] = resource_snapshot(torch, args.device)
    print('已离线加载 %s，%.1f ms；开始 %d 轮 × %d 条合成消息。' %
          (actual_device, cold_load_ms, args.rounds, len(requests)), flush=True)
    rows, summaries = [], []
    for round_number in range(1, args.rounds + 1):
        round_rows = []
        round_started = time.perf_counter()
        for request in requests:
            synchronize(torch, args.device)
            started = time.perf_counter()
            response = runtime.predict(request['state'], request['questions'], 'multilingual')
            synchronize(torch, args.device)
            elapsed_ms = (time.perf_counter() - started) * 1000
            answer, tokens = checked_answer(smoke, response)
            round_rows.append({'round': round_number, 'case': request['case'],
                               'expected': request['expected'], 'actual': answer['choice'],
                               'confidence': answer['confidence'], 'probabilities': answer['probabilities'],
                               'state_bytes': request['state_bytes'], 'input_tokens': tokens,
                               'latency_ms': elapsed_ms})
        wall_ms = (time.perf_counter() - round_started) * 1000
        summary = {'round': round_number, **latency_summary(round_rows, wall_ms)}
        rows.extend(round_rows)
        summaries.append(summary)
        snapshots['after_round_%d' % round_number] = resource_snapshot(torch, args.device)
        print('第 %d 轮：p50 %.1f ms，p95 %.1f ms，%.2f 条/秒。' %
              (round_number, summary['p50_ms'], summary['p95_ms'],
               summary['throughput_messages_per_second']), flush=True)
    environment = {'device_requested': args.device, 'device_actual': actual_device,
                   'python': platform.python_version(), 'platform': platform.platform(),
                   'machine': platform.machine(), 'torch': torch.__version__,
                   'threads_requested': args.threads, 'threads_effective': torch.get_num_threads(),
                   'mps_fallback_environment': os.environ.get('PYTORCH_ENABLE_MPS_FALLBACK', 'unset')}
    report = make_report(contract, requests, rows, summaries, cold_load_ms, snapshots, environment)
    validate_report(report)
    output = Path(args.output).expanduser().resolve() if args.output else CACHE / ('benchmark-%s.json' % args.device)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    print('Warm：' + json.dumps(report['warm'], ensure_ascii=False))
    print('合成基准报告：%s' % output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--device', choices=['cpu', 'mps'], default='cpu', help='每个进程只测试一个设备')
    parser.add_argument('--rounds', type=int, default=3, help='2 至 10 轮；第 1 轮单独记录，其余汇总为 warm')
    parser.add_argument('--threads', type=int, default=4, help='Torch CPU 线程数，默认 4（运行时不超过 CPU 数）')
    parser.add_argument('--output', help='JSON 报告路径，默认 .cache/laya/benchmark-<device>.json')
    parser.add_argument('--self-test', action='store_true', help='标准库离线自检，不加载或测量真实模型')
    args = parser.parse_args()
    if not 2 <= args.rounds <= 10 or args.threads < 1:
        parser.error('--rounds 必须在 2 至 10 之间，--threads 必须为正整数。')
    if args.self_test:
        self_test()
    else:
        run(args)


if __name__ == '__main__':
    try:
        main()
    except ModuleNotFoundError as error:
        raise SystemExit('缺少本地依赖 %s；先运行 scripts/setup-laya-local.py。仅检查脚本可加 --self-test。' % error.name)
    except (RuntimeError, OSError, ValueError) as error:
        raise SystemExit('未完成本地基准：%s' % error)
