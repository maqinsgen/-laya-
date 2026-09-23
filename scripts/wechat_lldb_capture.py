#!/usr/bin/env python3
"""Compatibility entry point for the packaged, canonical macOS helper."""
import importlib.util
from pathlib import Path
import sys

sys.dont_write_bytecode = True
_source = Path(__file__).resolve().parents[1] / 'resources/macos/login-capture/wechat_lldb_capture.py'
_spec = importlib.util.spec_from_file_location('_notewake_wechat_lldb_capture', _source)
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
globals().update({name: value for name, value in vars(_module).items() if not name.startswith('__')})
