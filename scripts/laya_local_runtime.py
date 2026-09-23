"""Notewake's offline, single-checkpoint Laya runtime (no remote Python code)."""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.cache' / 'laya'
MODEL_REPO = 'convaiinnovations/laya'
MODEL_REVISION = '5e7b2b1b8ca2ecdd3f2322d94069c9b6ce7e844b'
LAYA_VERSION = '0.3.9'
MODEL_FILES = [
    'multilingual/model.safetensors', 'multilingual/rl_agent_config.json',
    'multilingual/encoder/config.json', 'multilingual/tokenizer/tokenizer.json',
    'multilingual/tokenizer/tokenizer_config.json',
]


def configure_environment(offline=True):
    # Override shared HF locations and disable implicit credentials/telemetry.
    os.environ['HF_HOME'] = str(CACHE / 'huggingface')
    os.environ['HF_HUB_CACHE'] = str(CACHE / 'huggingface' / 'hub')
    os.environ['HF_HUB_DISABLE_IMPLICIT_TOKEN'] = '1'
    os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
    os.environ['HF_HUB_OFFLINE'] = '1' if offline else '0'
    os.environ['TRANSFORMERS_OFFLINE'] = '1' if offline else '0'
    os.environ['USE_TF'] = '0'
    os.environ['USE_TORCH'] = '1'
    os.environ['TOKENIZERS_PARALLELISM'] = 'false'


def model_path(download=False):
    configure_environment(offline=not download)
    from huggingface_hub import snapshot_download
    try:
        location = Path(snapshot_download(
            repo_id=MODEL_REPO, revision=MODEL_REVISION,
            allow_patterns=MODEL_FILES, token=False,
            local_files_only=not download, max_workers=2,
        ))
    except Exception as error:
        if download:
            raise
        raise RuntimeError('找不到完整的本地模型缓存；先运行 setup-laya-local.py 下载公开权重。') from error
    for relative in MODEL_FILES:
        if not (location / relative).is_file():
            raise RuntimeError('模型文件不完整；先运行 setup-laya-local.py 下载公开权重。')
    # Only known local JSON/tokenizer data and safetensors are accepted. No
    # trust_remote_code=True, pickle model, remote encoder, or dynamic auto_map.
    directory = location / 'multilingual'
    for name in ['rl_agent_config.json', 'encoder/config.json', 'tokenizer/tokenizer_config.json']:
        data = json.loads((directory / name).read_text(encoding='utf-8'))
        if data.get('auto_map'):
            raise RuntimeError('拒绝需要自定义远程代码的模型配置。')
    return directory


def load_local_agent(device='cpu', threads=4):
    configure_environment()
    from importlib.metadata import version
    if version('laya') != LAYA_VERSION:
        raise RuntimeError('需要 laya==%s，请重新运行隔离安装脚本。' % LAYA_VERSION)
    import torch
    import laya
    torch.set_num_threads(max(1, min(threads, os.cpu_count() or 1)))
    if device == 'mps' and not torch.backends.mps.is_available():
        raise RuntimeError('当前 PyTorch 或运行环境不支持 MPS；请明确使用 --device cpu。')
    if device == 'cuda' and not torch.cuda.is_available():
        raise RuntimeError('当前 PyTorch 或运行环境不支持 CUDA；请明确使用 --device cpu。')
    agent = laya.load(str(model_path()), device=device)
    if str(agent.device).split(':')[0] != device:
        raise RuntimeError('模型实际设备与指定设备不同，已停止，不会静默切换设备。')
    if agent.cfg.get('max_len') != 1024 or agent.cfg.get('head_max_len') != 256:
        raise RuntimeError('模型上下文配置与已审计的 multilingual 版本不一致。')
    return agent


def validate_budget(agent, state, questions):
    """Reject the SDK's silent truncation instead of classifying partial input."""
    from laya.common import render_options, serialize_state
    if not isinstance(questions, dict) or not 1 <= len(questions) <= 8:
        raise ValueError('本机服务每次接受 1 至 8 个短问题。')
    tok = agent.tok
    mask = tok.mask_token
    encode = lambda text: tok(text.replace(mask, ' '), add_special_tokens=False)['input_ids']
    state_size = len(encode(serialize_state(state)))
    for qid, definition in questions.items():
        agent._check_question(qid, definition)
        question = agent._to_internal(definition)
        option_sizes = [1 + len(encode(' ' + text)) for text in render_options(question)]
        head_size = len(encode('%s question: %s' % (question['t'], question['ins'])))
        if not option_sizes or any(size > 49 for size in option_sizes):
            raise ValueError('选项超过本机模型预算；请缩短选项。')
        head_room = agent.cfg['head_max_len'] - sum(option_sizes)
        if head_room < 16 or head_size > max(8, head_room):
            raise ValueError('问题超过本机模型题目预算；请缩短题目和选项。')
        state_room = agent.cfg['max_len'] - head_size - sum(option_sizes) - 4
        if state_size > state_room:
            raise ValueError('消息超过本机模型上下文；请缩短消息，不会静默截断分析。')


class LocalMultilingualRouter:
    """Adapter for the official HTTP app; never loads another checkpoint."""
    loaded = ['multilingual']

    def __init__(self, agent):
        self.agent = agent
        self._device_expected = str(agent.device) if hasattr(agent, 'device') else None

    def predict(self, state, questions, model=None):
        if model not in (None, 'multilingual'):
            raise ValueError('此本机服务仅启用 multilingual。')
        validate_budget(self.agent, state, questions)
        result = self.agent.predict(state, questions)
        # The upstream SDK can fall back to CPU on accelerator OOM during a
        # request. Do not report that result as an MPS/CUDA measurement.
        if self._device_expected is not None and str(self.agent.device) != self._device_expected:
            raise RuntimeError('推理期间模型设备发生变化（可能显存不足）；请停止服务并明确使用 --device cpu。')
        result['routing'] = {'model': 'multilingual', 'repo': MODEL_REPO,
                             'revision': MODEL_REVISION, 'reason': 'fixed local multilingual checkpoint'}
        return result
