#!/usr/bin/env python3
"""Own and supervise one LLDB child. Never signal the attached target process."""
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time

sys.dont_write_bytecode = True
from wechat_lldb_capture import _write_private


def read_private(path, limit=65536):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        owner = os.fstat(descriptor)
        if not stat.S_ISREG(owner.st_mode) or stat.S_IMODE(owner.st_mode) != 0o600 or owner.st_size > limit:
            raise ValueError('INVALID_PRIVATE_FILE')
        raw = os.read(descriptor, limit + 1)
        if len(raw) > limit:
            raise ValueError('INVALID_PRIVATE_FILE')
        return json.loads(raw), owner
    finally:
        os.close(descriptor)


def terminate_owned(child):
    """A new session belongs only to our LLDB and its own debugserver children."""
    if child.poll() is not None:
        return
    for sig, grace in ((signal.SIGINT, 3), (signal.SIGTERM, 2), (signal.SIGKILL, 2)):
        if child.poll() is not None:
            return
        try:
            os.killpg(child.pid, sig)
        except ProcessLookupError:
            return
        try:
            child.wait(timeout=grace)
            return
        except subprocess.TimeoutExpired:
            pass


def supervise(request_path):
    request_file = Path(request_path)
    directory = request_file.parent
    child = None
    owner = None
    completion = {'finished': True, 'stage': 'capture_error', 'captured': False, 'detached': False}
    try:
        request, owner = read_private(request_file)
        if time.time() * 1000 >= request.get('authorizationExpiresAt', float('inf')):
            completion['stage'] = 'cancelled'
            return 1
        details = directory.lstat()
        if not stat.S_ISDIR(details.st_mode) or stat.S_IMODE(details.st_mode) != 0o700 or details.st_uid != owner.st_uid:
            raise ValueError('INVALID_DIRECTORY')
        marker = directory / 'active'

        def active():
            try:
                details = marker.lstat()
                return (stat.S_ISREG(details.st_mode) and stat.S_IMODE(details.st_mode) == 0o600
                        and details.st_uid == owner.st_uid and marker.read_text() == request['requestId'])
            except (OSError, KeyError):
                return False

        if not active():
            completion['stage'] = 'cancelled'
            return 1
        if os.geteuid() != 0:
            completion['stage'] = 'administrator_required'
            return 1
        seconds = int(request['timeoutSeconds'])
        pid = int(request['pid'])
        if not 1 <= seconds <= 300 or pid <= 1:
            raise ValueError('INVALID_REQUEST')
        _write_private(directory / 'progress.json', {'stage': 'authorized', 'captured': False, 'detached': False}, owner)
        # A PID may have been recycled while the authorization dialog was open.
        observed = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'lstart='], capture_output=True,
                                  text=True, timeout=3, check=False).stdout.strip()
        if not observed or observed != request['startTime']:
            completion['stage'] = 'wrong_target'
            return 1
        if not active():
            completion['stage'] = 'cancelled'
            return 1
        helper = Path(__file__).with_name('wechat_lldb_capture.py')
        commands = ['/usr/bin/xcrun', 'lldb', '--no-lldbinit', '--batch',
                    '-o', 'command script import ' + json.dumps(str(helper)),
                    '-o', 'script wechat_lldb_capture.run(lldb.debugger, ' + json.dumps(str(request_file)) + ')']
        environment = dict(os.environ, PYTHONDONTWRITEBYTECODE='1')
        child = subprocess.Popen(commands, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, start_new_session=True, env=environment)
        launched = time.monotonic()
        ready_at = None
        cleanup_at = None
        cancelled = False
        timed_out = False
        latest = {}
        while child.poll() is None:
            now = time.monotonic()
            if not active():
                cancelled = True
                cleanup_at = cleanup_at or now
            try:
                latest, _ = read_private(directory / 'progress.json')
            except (OSError, ValueError):
                pass
            phase = latest.get('stage')
            if phase == 'ready' and ready_at is None:
                ready_at = now
            if phase in ('captured', 'stopping', 'detaching', 'detached', 'detach_failed', 'cancelled',
                         'capture_error', 'attach_denied', 'hardware_unavailable', 'wrong_target',
                         'unsupported_architecture', 'unexpected_stop', 'target_exited', 'timeout', 'continue_failed'):
                cleanup_at = cleanup_at or now
            if ((ready_at is None and now - launched > 20) or
                    (ready_at is not None and now - ready_at > seconds + 2)):
                timed_out = True
                cleanup_at = cleanup_at or now
                try:
                    marker.unlink()
                except OSError:
                    pass
            if cleanup_at is not None and now - cleanup_at > 15:
                terminate_owned(child)
                completion['stage'] = 'detach_failed'
                return 2
            time.sleep(0.1)
        try:
            latest, _ = read_private(directory / 'progress.json')
        except (OSError, ValueError):
            latest = {}
        completion.update({
            'stage': latest.get('stage', 'capture_error'),
            'captured': latest.get('captured') is True,
            'detached': latest.get('detached') is True,
        })
        if cancelled or not active():
            completion['stage'] = 'timeout' if timed_out else 'cancelled'
            completion['captured'] = False
        if child.returncode != 0 or not completion['detached']:
            completion['captured'] = False
            if latest.get('stage') != 'attach_denied':
                completion['stage'] = 'detach_failed'
        return 0 if completion['stage'] == 'detached' and completion['captured'] and completion['detached'] else 1
    except Exception:
        completion['stage'] = 'detach_failed' if child is not None else 'capture_error'
        return 2
    finally:
        if child is not None and child.poll() is None:
            terminate_owned(child)
            completion.update(stage='detach_failed', captured=False, detached=False)
        if not (completion['stage'] == 'detached' and completion['captured'] and completion['detached']):
            try:
                (directory / 'candidate.json').unlink()
            except OSError:
                pass
        if owner is not None and directory.is_dir():
            try:
                _write_private(directory / 'completion.json', completion, owner)
            except OSError:
                pass


if __name__ == '__main__':
    raise SystemExit(supervise(sys.argv[1]))
