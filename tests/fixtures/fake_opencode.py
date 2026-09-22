#!/usr/bin/python3
"""Protocol fixture: no provider, credentials, or external network required."""
import http.server
import json
import os
import pathlib
import sys
import time
import urllib.parse
import uuid

port = int(sys.argv[sys.argv.index('--port') + 1])
root = pathlib.Path.cwd()
storage = pathlib.Path(__file__).resolve().parent
history_path = storage / '.fake-opencode-history.json'
config = json.loads(os.environ['OPENCODE_CONFIG_CONTENT'])

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, value, status=200):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == '/global/health':
            return self.reply({'healthy': True, 'version': 'fixture'})
        if path == '/event':
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            try:
                while True:
                    self.wfile.write(b': heartbeat\n\n')
                    self.wfile.flush()
                    time.sleep(.1)
            except (BrokenPipeError, ConnectionResetError):
                return
        if path.endswith('/message'):
            histories = json.loads(history_path.read_text()) if history_path.exists() else {}
            return self.reply(histories.get(path.split('/')[2], []))
        if path == '/test/context':
            return self.reply({'cwd': str(root), 'query': urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)})
        if path == '/question':
            return self.reply([])
        return self.reply({})

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        value = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or '{}')
        if path == '/session':
            return self.reply({'id': 'ses_' + uuid.uuid4().hex})
        if path.endswith('/reply'):
            with (storage / '.fake-replies').open('a') as stream:
                stream.write(json.dumps(value) + '\n')
            return self.reply(True)
        if path == '/test/mutate':
            if config['permission'].get('bash') == 'deny':
                return self.reply({'blocked': True}, 403)
            return self.reply({'blocked': False})
        if path.endswith('/message'):
            messages = [
                {'info': {'id': 'msg_1', 'role': 'user'}, 'parts': value['parts']},
                {'info': {'id': 'msg_2', 'role': 'assistant', 'finish': 'stop'}, 'parts': [{'type': 'text', 'text': 'fixture response'}]},
            ]
            histories = json.loads(history_path.read_text()) if history_path.exists() else {}
            histories[path.split('/')[2]] = messages
            history_path.write_text(json.dumps(histories))
            return self.reply(messages[-1])
        return self.reply({})

http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
