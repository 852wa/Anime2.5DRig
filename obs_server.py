"""Local static server plus editor-to-OBS relay for Anime2.5DRig.

The editing browser sends face tracking values, the current settings
(parameters, expression, layers, anchors) and the opened PSD itself; the OBS
browser source (``?obs=1``) receives them over Server-Sent Events. Only
same-origin requests from localhost are accepted and nothing leaves this PC.
"""
import argparse
import json
import math
import mimetypes
import re
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

ROOT = str(Path(__file__).resolve().parent)
PROTOCOL = 'anime25d-relay-v2'
FEATURES = ['tracking', 'state', 'model']
MAX_TRACKING_BYTES = 8192
MAX_STATE_BYTES = 512 * 1024
MAX_MODEL_BYTES = 128 * 1024 * 1024
MAX_CLIENTS = 16
RANGES = {key: (-1, 1) for key in ('ax', 'ay', 'az', 'ex', 'ey')}
RANGES.update({key: (0, 1) for key in ('eL', 'eR', 'mo')})
OPTIONAL_RANGES = {'br': (-1, 1), 'mf': (-1, 1), 'mic': (0, 1)}
MODEL_ID = re.compile(r'^[0-9a-f]{1,16}-[0-9a-f]{1,8}-[0-9a-f]{1,8}$')

for ext, mime in {'.wasm': 'application/wasm', '.data': 'application/octet-stream',
                  '.binarypb': 'application/octet-stream', '.psd': 'application/octet-stream',
                  '.json': 'application/json', '.md': 'text/markdown; charset=utf-8',
                  '.js': 'text/javascript'}.items():
    mimetypes.add_type(mime, ext)


def _reject_constant(name):
    raise ValueError('Non-finite number: ' + name)


def loads(body):
    """json.loads that rejects NaN / Infinity (they cannot be re-encoded)."""
    return json.loads(body, parse_constant=_reject_constant)


def _number(value):
    return type(value) in (int, float) and math.isfinite(value)


def validate_tracking(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get('live'), bool):
        raise ValueError('Invalid tracking state')
    clean = {'live': payload['live']}
    for key, (low, high) in RANGES.items():
        value = payload.get(key)
        if not _number(value):
            raise ValueError('Invalid tracking number')
        clean[key] = max(low, min(high, value))
    for key, (low, high) in OPTIONAL_RANGES.items():
        if key not in payload:
            continue
        value = payload[key]
        if not _number(value):
            raise ValueError('Invalid tracking number')
        clean[key] = max(low, min(high, value))
    return clean


def validate_state(payload):
    """Structural check only; the browser validates every value again."""
    if not isinstance(payload, dict):
        raise ValueError('Invalid state')
    settings = payload.get('settings')
    if not isinstance(settings, dict) or settings.get('format') != 'anime25d-settings':
        raise ValueError('Invalid settings')
    if not isinstance(settings.get('modelId'), str) or not isinstance(settings.get('layers'), list):
        raise ValueError('Invalid settings')
    return {'type': 'state', 'settings': settings}


def sanitize_name(raw):
    try:
        name = unquote(raw or '', errors='strict')
    except UnicodeDecodeError:
        name = ''
    name = re.sub(r'[\x00-\x1f<>:"/\\|?*]+', '_', name).strip()[:120]
    return name or 'model.psd'


class Client:
    """Coalescing mailbox: keeps only the newest event of each kind."""
    ORDER = ('model', 'state', 'tracking')

    def __init__(self):
        self.cond = threading.Condition()
        self.pending = {}
        self.closed = False

    def put(self, kind, data):
        with self.cond:
            self.pending[kind] = data
            self.cond.notify()

    def take(self, timeout):
        with self.cond:
            if not self.pending and not self.closed:
                self.cond.wait(timeout)
            items = [(k, self.pending.pop(k)) for k in self.ORDER if k in self.pending]
            return items


class RelayHub:
    def __init__(self):
        self.lock = threading.Lock()
        self.clients = []
        self.state = None
        self.model = None      # (bytes, name, id, rev)
        self.rev = 0

    def add(self):
        with self.lock:
            if len(self.clients) >= MAX_CLIENTS:
                return None
            client = Client()
            self.clients.append(client)
            if self.model:
                client.put('model', self.model_event())
            if self.state:
                client.put('state', self.state)
            return client

    def remove(self, client):
        with self.lock:
            if client in self.clients:
                self.clients.remove(client)

    def publish(self, kind, data):
        with self.lock:
            targets = list(self.clients)
            if kind == 'state':
                self.state = data
        for client in targets:
            client.put(kind, data)

    def set_model(self, data, name, model_id):
        with self.lock:
            self.rev += 1
            self.model = (data, name, model_id, self.rev)
            # A new model makes the previous settings meaningless.
            if self.state and self.state.get('settings', {}).get('modelId') != model_id:
                self.state = None
            event = self.model_event()
        self.publish('model', event)

    def model_event(self):
        if not self.model:
            return None
        data, name, model_id, rev = self.model
        return {'id': model_id, 'name': name, 'rev': rev, 'size': len(data)}

    def info(self):
        with self.lock:
            return {'protocol': PROTOCOL, 'features': FEATURES, 'viewers': len(self.clients),
                    'model': self.model_event()}


hub = RelayHub()


class Handler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    # ---- helpers ----
    def same_origin(self):
        host = self.headers.get('Host', '')
        allowed = {f'{name}:{self.server.server_port}' for name in ('localhost', '127.0.0.1', '[::1]')}
        origin = self.headers.get('Origin')
        if host not in allowed or (origin and origin != 'http://' + host):
            self.send_error(403, 'Local same-origin requests only')
            return False
        return True

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

    def log_message(self, fmt, *args):
        if not getattr(self, 'path', '').startswith(('/tracking', '/state', '/model', '/relay-info')):
            super().log_message(fmt, *args)

    def send_json(self, code, payload):
        data = json.dumps(payload, separators=(',', ':'), allow_nan=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def send_empty(self, code=204):
        self.send_response(code)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def read_body(self, limit, content_type):
        if self.headers.get_content_type() != content_type:
            self.send_error(415)
            return None
        try:
            size = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            size = -1
        if size <= 0 or size > limit:
            self.send_error(413)
            return None
        self.connection.settimeout(60 if size > 1 << 20 else 5)
        chunks, remaining = [], size
        while remaining:
            chunk = self.rfile.read(min(remaining, 1 << 20))
            if not chunk:
                raise TimeoutError('Body ended early')
            chunks.append(chunk)
            remaining -= len(chunk)
        return b''.join(chunks)

    def hidden_path(self):
        path = unquote(urlsplit(self.path).path).replace('\\', '/')
        parts = path.split('/')
        return any(p.startswith('.') and p not in ('', '.') for p in parts) or \
            path.lower().rstrip('/').endswith(('.py', '.pyc', '.bat'))

    # ---- methods ----
    def do_HEAD(self):
        if self.same_origin():
            if self.hidden_path():
                self.send_error(404)
                return
            super().do_HEAD()

    def do_POST(self):
        if not self.same_origin():
            return
        path = urlsplit(self.path).path
        try:
            if path == '/tracking':
                body = self.read_body(MAX_TRACKING_BYTES, 'application/json')
                if body is None:
                    return
                payload = validate_tracking(loads(body))
                hub.publish('tracking', payload)
                self.send_empty()
            elif path == '/state':
                body = self.read_body(MAX_STATE_BYTES, 'application/json')
                if body is None:
                    return
                hub.publish('state', validate_state(loads(body)))
                self.send_empty()
            elif path == '/model':
                self.receive_model()
            else:
                self.send_error(404)
        except (ValueError, UnicodeDecodeError, OverflowError, RecursionError):
            self.send_error(400)
        except TimeoutError:
            self.send_error(408)

    def do_PUT(self):
        if not self.same_origin():
            return
        if urlsplit(self.path).path != '/model':
            self.send_error(404)
            return
        try:
            self.receive_model()
        except TimeoutError:
            self.send_error(408)

    def receive_model(self):
        model_id = self.headers.get('X-Model-Id', '')
        if not MODEL_ID.match(model_id):
            self.send_error(400, 'Invalid model id')
            return
        body = self.read_body(MAX_MODEL_BYTES, 'application/octet-stream')
        if body is None:
            return
        if len(body) < 26 or body[:4] != b'8BPS' or body[4:6] != b'\x00\x01':
            self.send_error(400, 'Not a PSD file')
            return
        hub.set_model(body, sanitize_name(self.headers.get('X-Model-Name')), model_id)
        self.send_empty()

    def do_GET(self):
        if not self.same_origin():
            return
        path = urlsplit(self.path).path
        if path == '/relay-info':
            self.send_json(200, hub.info())
        elif path == '/state/current':
            state = hub.state
            if state:
                self.send_json(200, state)
            else:
                self.send_empty(204)
        elif path == '/model/current':
            model = hub.model
            if not model:
                self.send_error(404)
                return
            data, name, model_id, _ = model
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Model-Name', quote(name))
            self.send_header('X-Model-Id', model_id)
            self.end_headers()
            self.wfile.write(data)
        elif path == '/tracking-events':
            self.stream_events()
        elif self.hidden_path():
            self.send_error(404)
        else:
            super().do_GET()

    def stream_events(self):
        client = hub.add()
        if client is None:
            self.send_error(503, 'Too many tracking clients')
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'keep-alive')
        self.end_headers()
        self.close_connection = True
        try:
            while True:
                items = client.take(15)
                if not items:
                    self.wfile.write(b': keepalive\n\n')
                for kind, data in items:
                    text = json.dumps(data, separators=(',', ':'), allow_nan=False)
                    prefix = '' if kind == 'tracking' else 'event:' + kind + '\n'
                    self.wfile.write((prefix + 'data:' + text + '\n\n').encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError, OSError, ValueError, TypeError):
            pass
        finally:
            hub.remove(client)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--open-browser', action='store_true')
    parser.add_argument('--camera', action='store_true')
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('port must be between 1 and 65535')
    try:
        server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    except OSError as error:
        parser.exit(1, f'Cannot start local server on port {args.port}: {error}\nUse --port to select another port.\n')
    url = f'http://127.0.0.1:{args.port}/'
    print('Anime2.5DRig OBS server: ' + url)
    print('OBS browser source: ' + url + '?obs=1')
    print('Open the editor in a normal browser; the PSD, settings and expressions you use there are mirrored to OBS.')
    if args.open_browser:
        webbrowser.open(url + ('?cam=1' if args.camera else ''))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
