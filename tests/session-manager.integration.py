#!/usr/bin/env python3
"""Real backend restarts + HTTP API against the local OpenCode protocol fixture.
Run after cargo build: python3 tests/session-manager.integration.py
"""
import concurrent.futures
import http.cookiejar
import json
import os
import pathlib
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

repo = pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='carobaguard-integration-') as temporary:
    root = pathlib.Path(temporary)
    workspace = root / 'workspace'
    workspace.mkdir()
    subprocess.run(['git', 'init', '-q', str(workspace)], check=True)
    (workspace / 'modified.txt').write_text('workspace context')
    fake = root / 'opencode'
    fake.write_bytes((repo / 'tests/fixtures/fake_opencode.py').read_bytes())
    fake.chmod(0o700)
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    env = dict(os.environ, CAROBAGUARD_DATA_DIR=str(root), CAROBAGUARD_HOST='127.0.0.1', CAROBAGUARD_PORT=str(port), CAROBAGUARD_ADMIN_USERNAME='integration', CAROBAGUARD_ADMIN_PASSWORD='integration-local-password', CAROBAGUARD_OPENCODE_BINARY=str(fake))
    process = None
    csrf = None
    jar = http.cookiejar.CookieJar()
    client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def request(path, method='GET', data=None):
        headers = {'Content-Type': 'application/json'}
        if csrf:
            headers['X-CSRF-Token'] = csrf
        req = urllib.request.Request(base + path, data=json.dumps(data).encode() if data is not None else None, headers=headers, method=method)
        with client.open(req, timeout=30) as response:
            return json.load(response)

    def start():
        global process, csrf
        process = subprocess.Popen([str(repo / 'target/debug/carobaguard')], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            assert process.poll() is None, 'backend exited during startup'
            try:
                request('/api/v1/health')
                break
            except urllib.error.URLError:
                time.sleep(.05)
        else:
            raise AssertionError('backend startup timeout')
        csrf = request('/api/v1/auth/login', 'POST', {'username': 'integration', 'password': 'integration-local-password'})['csrf_token']

    def action(session, name):
        return request(f'/api/v1/opencode/sessions/{session}/actions', 'POST', {'action': name})

    def stop():
        if process is not None and process.poll() is None:
            process.send_signal(signal.SIGTERM)
            process.wait(timeout=8)

    try:
        start()
        session = request('/api/v1/opencode/sessions', 'POST', {'title': 'Persistent HTTP workspace', 'project_path': str(workspace), 'permission_mode': 'read_only'})['id']
        with concurrent.futures.ThreadPoolExecutor(2) as executor:
            futures = [executor.submit(action, session, 'resume') for _ in range(2)]
            results = []
            for future in futures:
                try:
                    results.append(future.result())
                except urllib.error.HTTPError as error:
                    assert error.code == 503, error.code  # a concurrent operation is explicitly busy
            assert results and all(r['pid'] == results[0]['pid'] for r in results)
        request(f'/api/v1/opencode/sessions/{session}/messages', 'POST', {'message': 'preserve this context'})
        action(session, 'sleep')
        history = request(f'/api/v1/opencode/sessions/{session}/messages')
        assert history[0]['text'] == 'preserve this context'
        assert request('/api/v1/opencode/status')['pid'] is None
        action(session, 'resume')
        before = request(f'/api/v1/opencode/sessions/{session}')
        assert before['git']['modified_files'] == 1 and before['git']['clean'] is False
        assert before['session']['project_path'] == str(workspace)
        stop()
        start()
        restored = request(f'/api/v1/opencode/sessions/{session}')['session']
        assert restored['status'] == 'sleeping' and restored['pid'] is None
        assert restored['opencode_session_id'] == before['session']['opencode_session_id']
        assert request(f'/api/v1/opencode/sessions/{session}/messages') == history
        active = action(session, 'resume')
        os.kill(active['pid'], signal.SIGKILL)
        deadline = time.monotonic() + 5
        while request(f'/api/v1/opencode/sessions/{session}')['session']['status'] != 'error':
            assert time.monotonic() < deadline
            time.sleep(.05)
        action(session, 'resume')
        request(f'/api/v1/opencode/sessions/{session}/actions', 'POST', {'action': 'rename', 'title': 'Renamed workspace'})
        action(session, 'archive')
        request(f'/api/v1/opencode/sessions/{session}', 'DELETE')
        assert request('/api/v1/opencode/sessions') == []
        assert (workspace / 'modified.txt').read_text() == 'workspace context'
        print('PASS: HTTP creation, concurrent wake, history, sleep/resume, backend restart, dead child recovery, Git, rename, archive, deletion')
    finally:
        stop()
