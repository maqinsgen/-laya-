"""Supervised LLDB hardware-breakpoint capture; import inside LLDB only.

The CCKeyDerivationPBKDF capture point follows TANGandXUE/wcdb-key-tool
(79f1b5b92e12c66aa281b4a60a3c478b5f547dfa). This implementation never changes
an app signature, uses no software breakpoint, and never kills a target or
unrelated debugger. A captured passphrase still needs database verification.
"""
import json
import os
from pathlib import Path
import stat
import tempfile
import time


def _write_private(path, value, owner):
    fd, temporary = tempfile.mkstemp(prefix='.capture-', dir=str(path.parent))
    try:
        os.fchmod(fd, 0o600)
        if os.geteuid() == 0:
            os.fchown(fd, owner.st_uid, owner.st_gid)
        with os.fdopen(fd, 'w') as output:
            fd = -1
            json.dump(value, output)
        os.replace(temporary, path)
    finally:
        if fd >= 0:
            os.close(fd)
        if os.path.exists(temporary):
            os.unlink(temporary)


def run(debugger, request_path):
    import lldb
    request_file = Path(request_path)
    owner = request_file.lstat()
    if not stat.S_ISREG(owner.st_mode) or stat.S_IMODE(owner.st_mode) != 0o600:
        raise ValueError('REQUEST_PERMISSIONS')
    request = json.loads(request_file.read_text())
    pid = int(request['pid'])
    seconds = int(request.get('timeoutSeconds', 180))
    if pid <= 1 or not 1 <= seconds <= 300:
        raise ValueError('INVALID_REQUEST')
    directory = request_file.parent
    if stat.S_IMODE(directory.stat().st_mode) != 0o700:
        raise ValueError('DIRECTORY_PERMISSIONS')
    expected_executable = os.path.realpath(request['executable'])
    salts = {bytes.fromhex(value) for value in request['salts']}
    if not salts or any(len(value) != 16 for value in salts):
        raise ValueError('INVALID_SALTS')
    marker = directory / 'active'
    report = directory / 'progress.json'
    candidate_file = directory / 'candidate.json'
    if candidate_file.exists():
        raise ValueError('CANDIDATE_ALREADY_EXISTS')
    target = None
    process = None
    breakpoint_id = None
    captured = False
    attached = False
    detached = False
    hits = 0
    stage = 'attaching'
    started = time.monotonic()
    previous_async = debugger.GetAsync()
    listener = lldb.SBListener('notewake-capture')

    def marker_active():
        try:
            details = marker.lstat()
            if not stat.S_ISREG(details.st_mode) or stat.S_IMODE(details.st_mode) != 0o600:
                return False
            token = request.get('requestId')
            return details.st_uid == owner.st_uid and (not token or marker.read_text() == token)
        except OSError:
            return False

    def process_state():
        # Consuming a state-change event also updates LLDB's public state.
        event = lldb.SBEvent()
        while listener.GetNextEvent(event):
            pass
        return process.GetState()

    def progress(next_stage):
        nonlocal stage
        stage = next_stage
        _write_private(report, {
            'stage': stage, 'captured': captured, 'detached': detached,
            'hardware': breakpoint_id is not None, 'hits': hits,
            'elapsedMs': int((time.monotonic() - started) * 1000),
        }, owner)

    try:
        # Avoid macOS Developer Tools prompting inside a synchronous LLDB API
        # call. Obtain administrator authorization before launching this test.
        if os.geteuid() != 0:
            progress('administrator_required')
            return
        if not marker_active():
            progress('cancelled')
            return
        progress('attaching')
        debugger.SetAsync(True)
        target = debugger.CreateTarget('')
        error = lldb.SBError()
        # Native attach/detach can still block below the Python API; this is an
        # attended experiment, not a production hard-timeout guarantee.
        process = target.AttachToProcessWithID(listener, pid, error)
        attached = process.IsValid()
        if error.Fail() or not process.IsValid():
            progress('attach_denied')
            return
        attach_deadline = started + 15
        while process_state() != lldb.eStateStopped:
            if not marker_active():
                progress('cancelled')
                return
            if time.monotonic() >= attach_deadline:
                progress('attach_timeout')
                return
            if process_state() in (lldb.eStateExited, lldb.eStateDetached, lldb.eStateInvalid):
                progress('attach_denied')
                return
            time.sleep(0.1)
        if process.GetProcessID() != pid or os.path.realpath(str(target.GetExecutable().fullpath)) != expected_executable:
            progress('wrong_target')
            return
        if not target.GetTriple().split('-')[0].startswith('arm64'):
            progress('unsupported_architecture')
            return
        result = lldb.SBCommandReturnObject()
        debugger.GetCommandInterpreter().HandleCommand(
            'breakpoint set --hardware --skip-prologue false --name CCKeyDerivationPBKDF', result)
        if not result.Succeeded() or target.GetNumBreakpoints() != 1:
            progress('hardware_unavailable')
            return
        breakpoint = target.GetBreakpointAtIndex(0)
        if not breakpoint.IsHardware() or breakpoint.GetNumLocations() == 0:
            progress('hardware_unavailable')
            return
        breakpoint_id = breakpoint.GetID()
        last_stop = process.GetStopID()
        if process.Continue().Fail():
            progress('continue_failed')
            return
        progress('ready')
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if not marker_active():
                progress('cancelled')
                return
            state = process_state()
            if state in (lldb.eStateExited, lldb.eStateDetached, lldb.eStateInvalid):
                progress('target_exited')
                return
            if state == lldb.eStateStopped and process.GetStopID() != last_stop:
                last_stop = process.GetStopID()
                matched_breakpoint = False
                for thread in process:
                    if thread.GetStopReason() != lldb.eStopReasonBreakpoint:
                        continue
                    if thread.GetStopReasonDataAtIndex(0) != breakpoint_id:
                        continue
                    matched_breakpoint = True
                    hits += 1
                    frame = thread.GetFrameAtIndex(0)
                    registers = [frame.FindRegister('x%d' % i).GetValueAsUnsigned() for i in range(7)]
                    # CommonCrypto: PBKDF2, 32-byte input, 16-byte salt,
                    # HMAC-SHA512, 256,000 iterations. No expression evaluation.
                    if (registers[0], registers[2], registers[4], registers[5], registers[6]) != (2, 32, 16, 5, 256000):
                        continue
                    error = lldb.SBError()
                    salt = process.ReadMemory(registers[3], 16, error)
                    if error.Fail() or salt not in salts:
                        continue
                    password = process.ReadMemory(registers[1], 32, error)
                    if error.Fail() or len(password) != 32:
                        continue
                    if not marker_active() or time.monotonic() >= deadline:
                        progress('cancelled' if not marker_active() else 'timeout')
                        return
                    _write_private(candidate_file, {'passphrase': password.hex()}, owner)
                    captured = True
                    progress('captured')
                    return
                if not matched_breakpoint:
                    progress('unexpected_stop')
                    return
                if process.Continue().Fail():
                    progress('continue_failed')
                    return
                progress('ready')
            time.sleep(0.1)
        progress('timeout')
    except KeyboardInterrupt:
        progress('cancelled')
    except Exception:
        # Never include exception values, register contents or memory in logs.
        progress('capture_error')
    finally:
        finish_stage = stage

        def cleanup_progress(next_stage):
            try:
                progress(next_stage)
            except Exception:
                pass  # Reporting must never prevent interrupt or detach.

        try:
            if attached and process and process.IsValid():
                if process_state() in (lldb.eStateRunning, lldb.eStateStepping):
                    cleanup_progress('stopping')
                    process.SendAsyncInterrupt()
                    stop_deadline = time.monotonic() + 8
                    while process_state() in (lldb.eStateRunning, lldb.eStateStepping) and time.monotonic() < stop_deadline:
                        time.sleep(0.1)
                if process_state() in (lldb.eStateRunning, lldb.eStateStepping):
                    cleanup_progress('detach_failed')
                elif process_state() == lldb.eStateInvalid:
                    cleanup_progress('detach_failed')
                elif process_state() not in (lldb.eStateExited, lldb.eStateDetached):
                    if breakpoint_id is not None:
                        target.BreakpointDelete(breakpoint_id)
                    cleanup_progress('detaching')
                    detached = process.Detach(False).Success()
                else:
                    detached = True
                cleanup_progress('detached' if captured and detached else finish_stage if detached else 'detach_failed')
        except Exception:
            cleanup_progress('detach_failed')
        finally:
            try:
                debugger.SetAsync(previous_async)
            finally:
                if (not captured or not detached or not marker_active()) and candidate_file.exists():
                    candidate_file.unlink()
        print('Capture finished. Read the private progress file for status.')
