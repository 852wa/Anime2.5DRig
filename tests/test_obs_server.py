import http.client
import json
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from obs_server import Handler, ThreadingHTTPServer, validate_tracking


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

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        conn.request(method, path, body, headers or {})
        response = conn.getresponse()
        code, data = response.status, response.read()
        conn.close()
        return code, data

    def test_protocol_and_static(self):
        code, body = self.request('GET', '/relay-info')
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)['protocol'], 'anime25d-tracking-v1')
        self.assertEqual(self.request('GET', '/lib/app.js')[0], 200)

    def test_state_and_payload(self):
        payload = dict(live=False, ax=3, ay=0, az=0, ex=0, ey=0, eL=1, eR=1, mo=0)
        clean = validate_tracking(payload)
        self.assertFalse(clean['live'])
        self.assertEqual(clean['ax'], 1)
        self.assertEqual(self.request('POST', '/tracking', json.dumps(payload), {'Content-Type': 'application/json'})[0], 204)
        for bad in [[], {'live': True}, {**payload, 'ax': float('nan')}, {**payload, 'eL': True}]:
            with self.assertRaises(ValueError):
                validate_tracking(bad)

    def test_reject_external_origin_and_wrong_type(self):
        self.assertEqual(self.request('POST', '/tracking', '{}', {'Content-Type': 'application/json', 'Origin': 'https://example.com'})[0], 403)
        self.assertEqual(self.request('POST', '/tracking', '{}', {'Content-Type': 'text/plain'})[0], 415)
        self.assertEqual(self.request('POST', '/tracking', '{}', {'Content-Type': 'application/json'})[0], 400)
        self.assertEqual(self.request('GET', '/relay-info', headers={'Host': 'attacker.example'})[0], 403)
        self.assertEqual(self.request('POST', '/tracking', 'x'*8193, {'Content-Type': 'application/json'})[0], 413)

    def test_sse_preserves_live_false(self):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        conn.request('GET', '/tracking-events')
        response = conn.getresponse()
        self.assertEqual(response.status, 200)
        payload = dict(live=False, ax=0, ay=0, az=0, ex=0, ey=0, eL=1, eR=1, mo=0)
        self.assertEqual(self.request('POST', '/tracking', json.dumps(payload), {'Content-Type': 'application/json'})[0], 204)
        event = response.readline().decode()
        self.assertTrue(event.startswith('data:'))
        self.assertFalse(json.loads(event[5:])['live'])
        response.close()
        conn.close()


if __name__ == '__main__':
    unittest.main()
