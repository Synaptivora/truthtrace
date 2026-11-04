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

    def test_host_requires_exact_listener_port(self):
        for host in ['127.0.0.1:1', 'localhost:garbage', '[::1]:9999', '127.0.0.1']:
            self.assertEqual(self.request(path='/health', headers={'Host':host})[0], 403)

    def test_uploaded_chat_cannot_read_local_fixture(self):
        import tempfile
        import json
        with tempfile.TemporaryDirectory() as directory:
            secret = Path(directory)/'private.txt'
            secret.write_text('PRIVATE_FIXTURE_ONLY')
            payload={'records':[{'type':'file','name':'private.txt','file':str(secret),'media_ref':str(secret),'content':str(secret)}], 'media_dir':directory}
            status, body, _ = self.request('POST','/parse_chat',self.auth(**{'Content-Type':'application/json'}),json.dumps(payload).encode())
            self.assertEqual(status,400)
            self.assertNotIn(b'PRIVATE_FIXTURE_ONLY',body)
            with self.assertRaises(ValueError):
                module.build_media_evidence({'name':'private.txt','media_ref':str(secret)},allow_files=False)

    def test_managed_path_traversal_and_large_file(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)/'managed';root.mkdir()
            outside=Path(directory)/'outside.txt';outside.write_text('PRIVATE_FIXTURE_ONLY')
            for reference in ['../outside.txt',str(outside)]:
                with self.assertRaises(ValueError):
                    module.build_media_evidence({'name':'outside.txt','media_ref':reference},str(root))
            huge=root/'large.txt'
            with huge.open('wb') as output:output.truncate(module.REQUEST_LIMIT+1)
            with self.assertRaises(ValueError):module.build_media_evidence({'name':'large.txt','media_ref':'large.txt'},str(root))
            good=root/'good.txt';good.write_text('allowed fixture')
            self.assertEqual(module.build_media_evidence({'name':'good.txt','media_ref':'good.txt'},str(root))['content'],'allowed fixture')

    def test_managed_media_rejects_link_before_read(self):
        import tempfile
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            fixture=Path(directory)/'linked.txt';fixture.write_text('fixture')
            with patch.object(Path,'is_symlink',return_value=True):
                with self.assertRaises(ValueError):
                    module.build_media_evidence({'name':'linked.txt','media_ref':'linked.txt'},directory)

    def test_chat_media_archive_uses_shared_resource_guard(self):
        import io, zipfile, base64
        data=io.BytesIO()
        with zipfile.ZipFile(data,'w',zipfile.ZIP_DEFLATED) as archive:archive.writestr('huge.txt','0'*100000)
        item={'name':'bomb.docx','media_ref':'data:application/octet-stream;base64,'+base64.b64encode(data.getvalue()).decode()}
        with self.assertRaises(ValueError):module.build_media_evidence(item,allow_files=False)

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

class ArchiveTests(unittest.TestCase):
    def test_quota_and_expiry(self):
        import tempfile
        import time
        with tempfile.TemporaryDirectory() as directory:
            previous = module.UPLOAD_DIR
            module.UPLOAD_DIR = directory
            try:
                entry = Path(directory) / 'abcdefabcdef.txt'
                entry.write_bytes(b'old')
                os.utime(entry, (time.time()-8*86400, time.time()-8*86400))
                stored = module.save_upload(b'new', 'new.txt')
                self.assertFalse(entry.exists())
                self.assertEqual((Path(directory)/stored).read_bytes(), b'new')
                with (Path(directory)/'large.bin').open('wb') as output:
                    output.truncate(250*1024*1024)
                with self.assertRaises(ValueError):
                    module.save_upload(b'blocked', 'blocked.txt')
                self.assertFalse((Path(directory)/'.archive.lock').exists())
            finally:
                module.UPLOAD_DIR = previous

if __name__ == '__main__':
    unittest.main()

