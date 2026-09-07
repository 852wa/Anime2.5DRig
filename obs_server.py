"""Local static server plus Chrome-to-OBS face-tracking relay."""
import json
import argparse
import math
import queue
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

clients = []
clients_lock = threading.Lock()
ROOT = str(Path(__file__).resolve().parent)
RANGES = {key: (-1, 1) for key in ('ax', 'ay', 'az', 'ex', 'ey')}
RANGES.update({key: (0, 1) for key in ('eL', 'eR', 'mo')})


def validate_tracking(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get('live'), bool):
        raise ValueError('Invalid tracking state')
    clean = {'live': payload['live']}
    for key, (low, high) in RANGES.items():
        value = payload.get(key)
        if type(value) not in (int, float) or not math.isfinite(value):
            raise ValueError('Invalid tracking number')
        clean[key] = max(low, min(high, value))
    return clean


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

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
        if not self.path.startswith('/tracking'):
            super().log_message(fmt, *args)

    def do_HEAD(self):
        if self.same_origin():
            super().do_HEAD()

    def do_POST(self):
        if not self.same_origin():
            return
        if self.path != "/tracking":
            self.send_error(404)
            return
        try:
            if self.headers.get_content_type() != 'application/json':
                self.send_error(415)
                return
            size = int(self.headers.get('Content-Length', '0'))
            if size <= 0 or size > 8192:
                self.send_error(413)
                return
            self.connection.settimeout(5)
            payload = validate_tracking(json.loads(self.rfile.read(size)))
            data = json.dumps(payload, separators=(",", ":"), allow_nan=False)
            with clients_lock:
                for target in clients[:]:
                    try:
                        target.put_nowait(data)
                    except queue.Full:
                        try:
                            target.get_nowait()
                            target.put_nowait(data)
                        except (queue.Empty, queue.Full):
                            pass
            self.send_response(204)
            self.end_headers()
        except (ValueError, UnicodeDecodeError, OverflowError):
            self.send_error(400)
        except TimeoutError:
            self.send_error(408)

    def do_GET(self):
        if not self.same_origin():
            return
        if urlsplit(self.path).path == '/relay-info':
            data = b'{"protocol":"anime25d-tracking-v1"}'
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(data)
            return
        if self.path != "/tracking-events":
            super().do_GET()
            return
        target = queue.Queue(maxsize=2)
        with clients_lock:
            if len(clients) >= 16:
                self.send_error(503, 'Too many tracking clients')
                return
            clients.append(target)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        try:
            while True:
                try:
                    data = target.get(timeout=15)
                    self.wfile.write(("data:" + data + "\n\n").encode())
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        finally:
            with clients_lock:
                if target in clients:
                    clients.remove(target)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--open-browser', action='store_true')
    parser.add_argument('--camera', action='store_true')
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('port must be between 1 and 65535')
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as error:
        parser.exit(1, f'Cannot start local server on port {args.port}: {error}\nUse --port to select another port.\n')
    url = f'http://127.0.0.1:{args.port}/'
    print('Anime2.5DRig OBS server: ' + url)
    print('OBS browser source: ' + url + '?obs=1' + ('&cam=1' if args.camera else ''))
    if args.open_browser:
        webbrowser.open(url + ('?cam=1' if args.camera else ''))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
