import importlib.util
import http.client
import os
from pathlib import Path
import threading
import unittest

os.environ['TRUTHTRACE_INGESTION_TOKEN'] = 'test-only-service-token'
spec = importlib.util.spec_from_file_location('ingestion_security', Path(__file__).parents[1] / 'server.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class SecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = module.ThreadingHTTPServer(('127.0.0.1', 0), module.Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def request(self, method='GET', path='/source/list', headers=None, body=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        conn.request(method, path, body=body, headers=headers or {})
        response = conn.getresponse()
        result = response.status, response.read(), dict(response.getheaders())
        conn.close()
        return result

    def auth(self, **extra):
        return {'Authorization': 'Bearer test-only-service-token', **extra}

    def test_health(self):
        self.assertEqual(self.request(path='/health')[0], 200)

    def test_unauthorized_reads(self):
        for path in ['/source/list', '/source/status', '/files/abcdefabcdef.txt']:
            self.assertEqual(self.request(path=path)[0], 401)

    def test_origin_host(self):
        for headers in [self.auth(Origin='null'), self.auth(Origin='https://evil.test'), self.auth(Host='evil.test')]:
            self.assertEqual(self.request(headers=headers)[0], 403)

    def test_limits(self):
        for length, expected in [('26214401', 413), ('-1', 400), ('garbage', 400)]:
            status, body, _ = self.request('POST', '/parse', self.auth(**{'Content-Length': length}))
            self.assertEqual(status, expected)
            self.assertIn(b'traceId', body)

    def test_valid_chat(self):
        body = b'{"records":[{"sender":"Alice","text":"hello","timestamp":"2026-01-01"}]}'
        status, _, _ = self.request('POST', '/parse_chat', self.auth(**{'Content-Type':'application/json'}), body)
        self.assertEqual(status, 200)

    def test_no_wildcard_cors(self):
        self.assertNotIn('Access-Control-Allow-Origin', self.request(path='/health')[2])

    def test_authenticated_source(self):
        self.assertEqual(self.request(path='/service', headers=self.auth())[0], 200)

if __name__ == '__main__':
    unittest.main()

