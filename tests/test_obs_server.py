import http.client
import json
import sys
import threading
import unittest
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import obs_server  # noqa: E402
from obs_server import Handler, ThreadingHTTPServer, validate_state, validate_tracking  # noqa: E402

TRACK = dict(live=False, ax=0, ay=0, az=0, ex=0, ey=0, eL=1, eR=1, mo=0)
PSD = b'8BPS\x00\x01' + b'\x00' * 40
JSON = {'Content-Type': 'application/json'}


def state(model_id='1-2-3'):
    return {'type': 'state', 'settings': {'format': 'anime25d-settings', 'version': 2, 'modelId': model_id,
                                          'params': {'angleX': 0.5}, 'layers': []}}


class RelayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        obs_server.hub = obs_server.RelayHub()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        conn.request(method, path, body, headers or {})
        response = conn.getresponse()
        code, data, head = response.status, response.read(), response.msg
        conn.close()
        return code, data, head

    def events(self):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        conn.request('GET', '/tracking-events')
        response = conn.getresponse()
        self.assertEqual(response.status, 200)

        def read_event():
            kind, data = 'message', None
            while True:
                line = response.readline().decode()
                if line.startswith(':'):
                    continue
                if line.startswith('event:'):
                    kind = line[6:].strip()
                elif line.startswith('data:'):
                    data = json.loads(line[5:])
                elif line == '\n' and data is not None:
                    return kind, data
        return conn, response, read_event

    def test_protocol_and_static(self):
        code, body, _ = self.request('GET', '/relay-info')
        self.assertEqual(code, 200)
        info = json.loads(body)
        self.assertEqual(info['protocol'], 'anime25d-relay-v2')
        self.assertEqual(set(info['features']), {'tracking', 'state', 'model'})
        self.assertIsNone(info['model'])
        self.assertEqual(self.request('GET', '/lib/app.js')[0], 200)
        code, _, head = self.request('GET', '/lib/vendor/face_mesh/face_mesh_solution_simd_wasm_bin.wasm')
        self.assertEqual(code, 200)
        self.assertEqual(head['Content-Type'], 'application/wasm')

    def test_hidden_files_are_not_served(self):
        for path in ('/.git/config', '/obs_server.py', '/start_obs.bat', '/.gitignore',
                     '/%2Egit/config', '/obs_server%2Epy', '/%2Egitignore', '/OBS_SERVER.PY'):
            self.assertEqual(self.request('GET', path)[0], 404, path)

    def test_non_finite_numbers_and_garbage_are_rejected(self):
        bad = '{"type":"state","settings":{"format":"anime25d-settings","modelId":"a","layers":[],"x":NaN}}'
        self.assertEqual(self.request('POST', '/state', bad, JSON)[0], 400)
        self.assertEqual(self.request('POST', '/tracking', json.dumps(TRACK).replace('0', 'Infinity', 1), JSON)[0], 400)
        import socket
        with socket.create_connection(('127.0.0.1', self.server.server_port), timeout=3) as sock:
            sock.sendall(b'\x16\x03\x01 garbage\r\n\r\n')
            data = b''
            while len(data) < 65536:   # older Pythons answer with an HTTP/0.9-style error page
                chunk = sock.recv(4096)
                if not chunk:
                    break
                data += chunk
            self.assertIn(b'400', data)
        self.assertEqual(self.request('GET', '/relay-info')[0], 200, 'server still healthy')

    def test_tracking_payload(self):
        clean = validate_tracking(dict(TRACK, ax=3, br=-4, mic=0.5))
        self.assertFalse(clean['live'])
        self.assertEqual(clean['ax'], 1)
        self.assertEqual(clean['br'], -1)
        self.assertEqual(clean['mic'], 0.5)
        self.assertNotIn('mf', clean)
        self.assertEqual(self.request('POST', '/tracking', json.dumps(TRACK), JSON)[0], 204)
        for bad in [[], {'live': True}, {**TRACK, 'ax': float('nan')}, {**TRACK, 'eL': True}, {**TRACK, 'mic': '1'}]:
            with self.assertRaises(ValueError):
                validate_tracking(bad)

    def test_reject_external_origin_and_wrong_type(self):
        self.assertEqual(self.request('POST', '/tracking', '{}', {**JSON, 'Origin': 'https://example.com'})[0], 403)
        self.assertEqual(self.request('POST', '/tracking', '{}', {'Content-Type': 'text/plain'})[0], 415)
        self.assertEqual(self.request('POST', '/tracking', '{}', JSON)[0], 400)
        self.assertEqual(self.request('GET', '/relay-info', headers={'Host': 'attacker.example'})[0], 403)
        self.assertEqual(self.request('POST', '/tracking', 'x' * 8193, JSON)[0], 413)
        self.assertEqual(self.request('PUT', '/model', PSD, {'Content-Type': 'application/octet-stream',
                                                             'X-Model-Id': '1-2-3', 'Origin': 'http://evil.test'})[0], 403)

    def test_state_roundtrip(self):
        self.assertEqual(self.request('GET', '/state/current')[0], 204)
        self.assertEqual(self.request('POST', '/state', json.dumps(state()), JSON)[0], 204)
        code, body, _ = self.request('GET', '/state/current')
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)['settings']['params']['angleX'], 0.5)
        for bad in [[], {'settings': {}}, {'settings': {'format': 'x', 'modelId': 'a', 'layers': []}},
                    {'settings': {'format': 'anime25d-settings', 'modelId': 1, 'layers': []}}]:
            with self.assertRaises(ValueError):
                validate_state(bad)
        self.assertEqual(self.request('POST', '/state', '{"settings":1}', JSON)[0], 400)

    def test_model_upload_and_download(self):
        headers = {'Content-Type': 'application/octet-stream', 'X-Model-Id': 'ab-cd-ef',
                   'X-Model-Name': quote('キャラ<1>.psd')}
        self.assertEqual(self.request('PUT', '/model', b'not a psd' * 4, headers)[0], 400)
        self.assertEqual(self.request('PUT', '/model', PSD, {**headers, 'X-Model-Id': '../x'})[0], 400)
        self.assertEqual(self.request('POST', '/state', json.dumps(state('old-1-1')), JSON)[0], 204)
        self.assertEqual(self.request('PUT', '/model', PSD, headers)[0], 204)
        code, body, head = self.request('GET', '/model/current')
        self.assertEqual(code, 200)
        self.assertEqual(body, PSD)
        self.assertEqual(head['X-Model-Id'], 'ab-cd-ef')
        self.assertEqual(obs_server.unquote(head['X-Model-Name']), 'キャラ_1_.psd')
        info = json.loads(self.request('GET', '/relay-info')[1])
        self.assertEqual(info['model']['id'], 'ab-cd-ef')
        self.assertEqual(self.request('GET', '/state/current')[0], 204, 'a new model drops stale settings')

    def test_sse_sends_current_model_state_and_live_false(self):
        headers = {'Content-Type': 'application/octet-stream', 'X-Model-Id': '1-2-3', 'X-Model-Name': 'a.psd'}
        self.assertEqual(self.request('PUT', '/model', PSD, headers)[0], 204)
        self.assertEqual(self.request('POST', '/state', json.dumps(state()), JSON)[0], 204)
        conn, response, read_event = self.events()
        kind, data = read_event()
        self.assertEqual((kind, data['id']), ('model', '1-2-3'))
        kind, data = read_event()
        self.assertEqual(kind, 'state')
        self.assertEqual(json.loads(self.request('GET', '/relay-info')[1])['viewers'], 1)
        self.assertEqual(self.request('POST', '/tracking', json.dumps(TRACK), JSON)[0], 204)
        kind, data = read_event()
        self.assertEqual(kind, 'message')
        self.assertFalse(data['live'])
        response.close()
        conn.close()

    def test_client_mailbox_coalesces(self):
        client = obs_server.Client()
        for i in range(50):
            client.put('tracking', {'n': i})
        client.put('state', {'s': 1})
        items = client.take(0.1)
        self.assertEqual(items, [('state', {'s': 1}), ('tracking', {'n': 49})])
        self.assertEqual(client.take(0.01), [])


if __name__ == '__main__':
    unittest.main()
