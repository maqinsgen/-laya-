#!/usr/bin/env python3
"""Isolated helper/supervisor contracts: no LLDB, elevation or real process."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
RESOURCES = Path(__file__).resolve().parents[1] / 'resources' / 'macos' / 'login-capture'


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, RESOURCES / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


helper = load('wechat_lldb_capture', 'wechat_lldb_capture.py')
supervisor = load('notewake_supervisor_fixture', 'supervisor.py')
PASSWORD = bytes(range(32))
SALT = bytes(range(16))


def write_private(path, value, _owner=None):
    path.write_text(json.dumps(value), encoding='utf8')
    path.chmod(0o600)


class Clock:
    def __init__(self):
        self.now = 1000.0
        self.on_sleep = None

    def monotonic(self):
        return self.now

    def time(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds
        if self.on_sleep:
            self.on_sleep()


class Result:
    def __init__(self, success=True):
        self.success = success

    def Fail(self):
        return not self.success

    def Success(self):
        return self.success

    def Succeeded(self):
        return self.success


class LoginHelperTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='notewake-login-mock-')
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.directory.chmod(0o700)
        self.request = {
            'pid': 4242, 'executable': '/synthetic/WeChat.app/Contents/MacOS/WeChat',
            'startTime': 'synthetic-start', 'timeoutSeconds': 1,
            'requestId': 'synthetic-request', 'salts': [SALT.hex()],
        }
        self.request_path = self.directory / 'request.json'
        write_private(self.request_path, self.request)
        self.marker = self.directory / 'active'
        self.marker.write_text(self.request['requestId'], encoding='utf8')
        self.marker.chmod(0o600)
        self.candidate = self.directory / 'candidate.json'

    def run_helper(self, mode='normal'):
        clock = Clock()
        api = types.ModuleType('lldb')
        for index, name in enumerate(['eStateInvalid', 'eStateStopped', 'eStateRunning',
                                     'eStateStepping', 'eStateExited', 'eStateDetached',
                                     'eStopReasonBreakpoint']):
            setattr(api, name, index)
        api.SBError = Result
        api.SBCommandReturnObject = Result
        api.SBEvent = object
        api.SBListener = lambda _name: types.SimpleNamespace(GetNextEvent=lambda _event: False)
        state = {'value': api.eStateStopped, 'stop': 0, 'detach': 0, 'interrupt': 0,
                 'deleted': [], 'async': False, 'attach': 0, 'stages': []}
        registers = [2, 0x1000, 32, 0x2000, 16, 5, 256000]
        frame = types.SimpleNamespace(FindRegister=lambda name: types.SimpleNamespace(
            GetValueAsUnsigned=lambda: registers[int(name[1:])]))
        thread = types.SimpleNamespace(
            GetStopReason=lambda: api.eStopReasonBreakpoint,
            GetStopReasonDataAtIndex=lambda _index: 7,
            GetFrameAtIndex=lambda _index: frame,
        )

        class Process:
            def IsValid(self):
                return True

            def GetState(self):
                return state['value']

            def GetProcessID(self):
                return 4243 if mode == 'wrong_pid' else 4242

            def GetStopID(self):
                return state['stop']

            def Continue(self):
                state['stop'] += 1
                # Simulate the next hardware hit without running a process.
                state['value'] = api.eStateStopped
                return Result()

            def ReadMemory(self, address, length, _error):
                value = SALT if address == 0x2000 else PASSWORD
                self.assert_length = len(value) == length
                if not self.assert_length:
                    raise AssertionError('Unexpected synthetic memory read')
                return value

            def SendAsyncInterrupt(self):
                state['interrupt'] += 1
                state['value'] = api.eStateStopped

            def Detach(self, keep_stopped):
                if keep_stopped:
                    raise AssertionError('Detach must resume the target')
                state['detach'] += 1
                if mode == 'detach_failure':
                    return Result(False)
                state['value'] = api.eStateDetached
                return Result()

            def __iter__(self):
                return iter([thread])

        process = Process()
        breakpoint = types.SimpleNamespace(IsHardware=lambda: True, GetNumLocations=lambda: 1, GetID=lambda: 7)

        def attach(_listener, pid, _error):
            self.assertEqual(pid, self.request['pid'])
            state['attach'] += 1
            return process

        target = types.SimpleNamespace(
            AttachToProcessWithID=attach,
            GetExecutable=lambda: types.SimpleNamespace(fullpath=self.request['executable']),
            GetTriple=lambda: 'arm64-apple-macos', GetNumBreakpoints=lambda: 1,
            GetBreakpointAtIndex=lambda _index: breakpoint,
            BreakpointDelete=lambda identifier: state['deleted'].append(identifier),
        )
        debugger = types.SimpleNamespace(
            GetAsync=lambda: state['async'],
            SetAsync=lambda enabled: state.update({'async': enabled}),
            CreateTarget=lambda _name: target,
            GetCommandInterpreter=lambda: types.SimpleNamespace(HandleCommand=lambda _command, _result: None),
        )

        def report(path, value, owner):
            if path.name == 'progress.json':
                state['stages'].append(value['stage'])
                self.assertNotIn(PASSWORD.hex(), json.dumps(value))
                if value['stage'] == 'ready' and mode == 'cancel':
                    self.marker.unlink()
                    state['value'] = api.eStateRunning
                if mode == 'report_failure' and value['stage'] == 'detaching':
                    raise OSError('synthetic progress write failure')
            write_private(path, value, owner)
            if path.name == 'candidate.json' and mode == 'invalid_after_capture':
                state['value'] = api.eStateInvalid

        with patch.dict(sys.modules, {'lldb': api}), patch.object(helper, 'time', clock), \
                patch.object(helper.os, 'geteuid', return_value=0), \
                patch.object(helper, '_write_private', side_effect=report), \
                contextlib.redirect_stdout(io.StringIO()):
            helper.run(debugger, str(self.request_path))
        state['progress'] = json.loads((self.directory / 'progress.json').read_text())
        self.assertFalse(state['async'], 'the original debugger async setting must be restored')
        return state

    def test_normal_capture_detaches_and_keeps_private_candidate_for_parent(self):
        state = self.run_helper()
        self.assertEqual(state['detach'], 1)
        self.assertEqual(state['deleted'], [7])
        self.assertEqual(state['progress']['stage'], 'detached')
        self.assertTrue(state['progress']['captured'])
        self.assertTrue(state['progress']['detached'])
        self.assertEqual(self.candidate.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(self.candidate.read_text()), {'passphrase': PASSWORD.hex()})

    def test_invalid_state_after_capture_never_claims_detached(self):
        state = self.run_helper('invalid_after_capture')
        self.assertEqual(state['progress']['stage'], 'detach_failed')
        self.assertFalse(state['progress']['detached'])
        self.assertEqual(state['detach'], 0)
        self.assertFalse(self.candidate.exists(), 'an unconfirmed detach must discard the candidate')

    def test_failed_detach_discards_candidate(self):
        state = self.run_helper('detach_failure')
        self.assertEqual(state['detach'], 1)
        self.assertEqual(state['progress']['stage'], 'detach_failed')
        self.assertFalse(state['progress']['detached'])
        self.assertFalse(self.candidate.exists())

    def test_wrong_attached_pid_is_rejected_and_detached(self):
        state = self.run_helper('wrong_pid')
        self.assertEqual(state['progress']['stage'], 'wrong_target')
        self.assertEqual(state['detach'], 1)
        self.assertFalse(state['progress']['captured'])
        self.assertNotIn('ready', state['stages'])
        self.assertFalse(self.candidate.exists())

    def test_marker_cancellation_interrupts_and_detaches_without_candidate(self):
        state = self.run_helper('cancel')
        self.assertEqual(state['interrupt'], 1)
        self.assertEqual(state['detach'], 1)
        self.assertEqual(state['progress']['stage'], 'cancelled')
        self.assertFalse(state['progress']['captured'])
        self.assertFalse(self.candidate.exists())

    def test_cleanup_progress_failure_does_not_prevent_detach(self):
        state = self.run_helper('report_failure')
        self.assertIn('detaching', state['stages'])
        self.assertEqual(state['detach'], 1)
        self.assertTrue(state['progress']['detached'])
        self.assertEqual(state['progress']['stage'], 'detached')

    def run_supervisor(self, mode='hung'):
        clock = Clock()
        signalled = []
        launched = []

        class Child:
            pid = 98765
            returncode = None

            def poll(self):
                return self.returncode

            def wait(self, timeout):
                if self.returncode is None:
                    raise subprocess.TimeoutExpired('synthetic-debugger', timeout)
                return self.returncode

        child = Child()

        def popen(command, **options):
            launched.append((command, options))
            self.assertEqual(command[:4], ['/usr/bin/xcrun', 'lldb', '--no-lldbinit', '--batch'])
            self.assertTrue(options['start_new_session'])
            self.assertEqual(options['stdin'], subprocess.DEVNULL)
            write_private(self.candidate, {'passphrase': PASSWORD.hex()})
            if mode == 'late_candidate':
                write_private(self.directory / 'progress.json', {'stage': 'ready'})

                def finish_after_cancel():
                    self.marker.unlink(missing_ok=True)
                    write_private(self.candidate, {'passphrase': PASSWORD.hex()})
                    write_private(self.directory / 'progress.json', {'stage': 'detached', 'captured': True, 'detached': True})
                    child.returncode = 0
                    clock.on_sleep = None

                clock.on_sleep = finish_after_cancel
            return child

        def killpg(group, sent_signal):
            signalled.append((group, sent_signal))
            self.assertEqual(group, child.pid, 'only the owned debugger process group may be signalled')
            self.assertNotEqual(group, self.request['pid'], 'never signal the WeChat target')
            if sent_signal == signal.SIGKILL:
                child.returncode = -signal.SIGKILL

        if mode == 'missing_marker':
            self.marker.unlink()
        if mode == 'expired_authorization':
            self.request['authorizationExpiresAt'] = int(clock.time() * 1000) - 1
            write_private(self.request_path, self.request)
        observed = 'different-start' if mode == 'wrong_target' else self.request['startTime']
        with patch.object(supervisor, 'time', clock), \
                patch.object(supervisor.os, 'geteuid', return_value=501 if mode == 'unprivileged' else 0), \
                patch.object(supervisor.os, 'killpg', side_effect=killpg), \
                patch.object(supervisor, '_write_private', side_effect=write_private), \
                patch.object(supervisor.subprocess, 'Popen', side_effect=popen), \
                patch.object(supervisor.subprocess, 'run', return_value=types.SimpleNamespace(stdout=observed)):
            result = supervisor.supervise(str(self.request_path))
        completion = json.loads((self.directory / 'completion.json').read_text())
        self.assertNotIn(PASSWORD.hex(), json.dumps(completion))
        return result, completion, launched, signalled

    def test_no_authorization_late_authorization_and_replaced_pid_never_launch(self):
        for mode, expected in [('unprivileged', 'administrator_required'), ('missing_marker', 'cancelled'),
                               ('expired_authorization', 'cancelled'), ('wrong_target', 'wrong_target')]:
            with self.subTest(mode=mode):
                # Restore the request files between these independent preflights.
                self.request.pop('authorizationExpiresAt', None)
                write_private(self.request_path, self.request)
                self.marker.write_text(self.request['requestId'], encoding='utf8')
                self.marker.chmod(0o600)
                result, completion, launched, signalled = self.run_supervisor(mode)
                self.assertNotEqual(result, 0)
                self.assertEqual(completion['stage'], expected)
                self.assertFalse(completion['captured'])
                self.assertFalse(launched)
                self.assertFalse(signalled)
                self.assertFalse(self.candidate.exists())

    def test_hung_owned_debugger_fails_closed_and_cleans_candidate(self):
        result, completion, launched, signalled = self.run_supervisor('hung')
        self.assertEqual(result, 2)
        self.assertEqual(len(launched), 1)
        self.assertEqual([item[1] for item in signalled], [signal.SIGINT, signal.SIGTERM, signal.SIGKILL])
        self.assertEqual(completion['stage'], 'detach_failed')
        self.assertFalse(completion['captured'])
        self.assertFalse(completion['detached'])
        self.assertFalse(self.candidate.exists())

    def test_candidate_arriving_after_marker_cancellation_is_discarded(self):
        result, completion, launched, signalled = self.run_supervisor('late_candidate')
        self.assertEqual(len(launched), 1)
        self.assertNotEqual(result, 0)
        self.assertEqual(completion['stage'], 'cancelled')
        self.assertFalse(completion['captured'])
        self.assertFalse(self.candidate.exists())
        self.assertFalse(signalled, 'a debugger that already detached needs no signal')


if __name__ == '__main__':
    unittest.main(verbosity=2)
