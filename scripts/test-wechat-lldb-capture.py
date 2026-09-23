"""Exercise hardware capture/detach against a generated local test process only."""
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


def stop_debugger(debugger):
    if debugger and debugger.poll() is None:
        debugger.send_signal(signal.SIGINT)
        try:
            debugger.wait(timeout=5)
        except subprocess.TimeoutExpired:
            # A process group created by this synthetic test only. Never use
            # this forced cleanup for a debugger attached to a user's app.
            os.killpg(debugger.pid, signal.SIGKILL)
            debugger.wait(timeout=5)

SOURCE = r'''
#include <CommonCrypto/CommonKeyDerivation.h>
#include <unistd.h>
#include <string.h>
#include <stdio.h>
int main(int argc, char **argv) {
    unsigned char output[32], salt[16];
    char password[32]; memset(password, 'S', 32); memset(salt, 1, 16);
    for (int i = 0; i < 30; i++) {
        sleep(1);
        if (argc == 1) CCKeyDerivationPBKDF(kCCPBKDF2, password, 32, salt, 16,
            kCCPRFHmacAlgSHA512, 256000, output, 32);
        puts("tick"); fflush(stdout);
    }
    return 0;
}
'''


def main():
    if os.geteuid() != 0:
        raise SystemExit('This synthetic LLDB test needs macOS administrator authorization.')
    with tempfile.TemporaryDirectory(prefix='notewake-lldb-test-') as temporary:
        directory = Path(temporary)
        source = directory / 'fixture.c'
        executable = directory / 'fixture'
        source.write_text(SOURCE)
        subprocess.run(['/usr/bin/clang', '-O0', str(source), '-o', str(executable)], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        results = []
        for mode in ['capture', 'timeout', 'cancel']:
            case = directory / mode
            case.mkdir(mode=0o700)
            heartbeat = case / 'heartbeat'
            with heartbeat.open('wb') as ticks:
                target = subprocess.Popen([str(executable)] + ([] if mode == 'capture' else ['idle']),
                                          stdout=ticks, stderr=subprocess.DEVNULL)
            debugger = None
            try:
                request = case / 'request.json'
                request.write_text(json.dumps({'pid': target.pid, 'executable': str(executable),
                    'timeoutSeconds': 5 if mode != 'timeout' else 2, 'salts': ['01' * 16]}))
                request.chmod(0o600)
                marker = case / 'active'
                marker.touch(mode=0o600)
                commands = [
                    '/usr/bin/xcrun', 'lldb', '--no-lldbinit', '--batch',
                    '-o', 'command script import ' + json.dumps(str(ROOT / 'scripts/wechat_lldb_capture.py')),
                    '-o', 'script wechat_lldb_capture.run(lldb.debugger, ' + json.dumps(str(request)) + ')',
                ]
                with (case / 'debugger.log').open('wb') as output:
                    debugger = subprocess.Popen(commands, stdout=output, stderr=subprocess.STDOUT,
                                                start_new_session=True)
                    deadline = time.monotonic() + 25
                    while debugger.poll() is None and time.monotonic() < deadline:
                        progress = case / 'progress.json'
                        if mode == 'cancel' and marker.exists() and progress.exists():
                            state = json.loads(progress.read_text())
                            if state['stage'] == 'ready':
                                marker.unlink()
                        time.sleep(0.1)
                    if debugger.poll() is None:
                        progress = case / 'progress.json'
                        state = json.loads(progress.read_text()) if progress.exists() else {'stage': 'not_started'}
                        print(json.dumps({'syntheticOnly': True, 'deadlineState': state}), flush=True)
                        stop_debugger(debugger)
                        raise AssertionError('Synthetic debugger exceeded its deadline')
                state = json.loads((case / 'progress.json').read_text())
                assert state['detached'], state
                assert state['hardware'], state
                assert target.poll() is None, 'Capture/timeout/cancel must leave the target alive'
                before = heartbeat.stat().st_size
                running_deadline = time.monotonic() + 3
                while heartbeat.stat().st_size == before and time.monotonic() < running_deadline:
                    time.sleep(0.1)
                assert heartbeat.stat().st_size > before, 'Detach must resume the target, not leave it stopped'
                candidate = case / 'candidate.json'
                if mode == 'capture':
                    assert state['captured'] and state['stage'] == 'detached', state
                    assert json.loads(candidate.read_text())['passphrase'] == (b'S' * 32).hex()
                    assert candidate.stat().st_mode & 0o777 == 0o600
                    assert (b'S' * 32).hex() not in (case / 'debugger.log').read_text()
                else:
                    assert not candidate.exists(), state
                    assert state['stage'] == ('cancelled' if mode == 'cancel' else 'timeout'), state
                results.append({'mode': mode, 'hardware': True, 'detached': True, 'targetAlive': True})
            finally:
                try:
                    stop_debugger(debugger)
                finally:
                    if target.poll() is None:
                        target.terminate()  # Only this test's own generated process.
                        target.send_signal(signal.SIGCONT)
                    try:
                        target.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        target.kill()  # Never an external app; our own fixture.
                        target.wait(timeout=5)
        print(json.dumps({'syntheticOnly': True, 'passed': results}))


if __name__ == '__main__':
    main()
