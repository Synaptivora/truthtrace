import os,sys,tempfile,threading,time,json,unittest
from pathlib import Path
from http.server import HTTPServer,BaseHTTPRequestHandler
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).parents[1]))
from ai_ingest.config import OpenAICompatibleClient
from ai_ingest.handle_files import HandleFiles

class ReviewSecurity(unittest.TestCase):
 def test_redirect_never_receives_key(self):
  received=[]
  class Sink(BaseHTTPRequestHandler):
   def log_message(self,*args):pass
   def do_GET(self):
    received.append(self.headers.get('Authorization'));self.send_response(200);self.end_headers();self.wfile.write(b'{}')
  sink=HTTPServer(('127.0.0.1',0),Sink)
  class Redirect(BaseHTTPRequestHandler):
   def log_message(self,*args):pass
   def do_POST(self):
    self.rfile.read(int(self.headers['Content-Length']));self.send_response(302);self.send_header('Location',f'http://127.0.0.1:{sink.server_port}/');self.end_headers()
  gateway=HTTPServer(('127.0.0.1',0),Redirect)
  for server in [sink,gateway]:threading.Thread(target=server.serve_forever,daemon=True).start()
  origin=f'http://127.0.0.1:{gateway.server_port}'
  try:
   with patch.dict(os.environ,{'TRUTHTRACE_MODEL_PRIVATE_ORIGINS':origin}):
    with self.assertRaises(RuntimeError) as error:OpenAICompatibleClient({'base_url':origin,'api_key':'synthetic-key','timeout':2})._post('chat/completions',{})
    self.assertNotIn('synthetic-key',str(error.exception));self.assertEqual(received,[])
  finally:
   for server in [gateway,sink]:server.shutdown();server.server_close()
 def test_private_destination_needs_explicit_grant(self):
  with patch.dict(os.environ,{'TRUTHTRACE_MODEL_PRIVATE_ORIGINS':''}):
   with self.assertRaises(RuntimeError):OpenAICompatibleClient({'base_url':'http://127.0.0.1:1','api_key':'fixture','timeout':1})._post('x',{})
 def test_quota_expiry_and_original_protection(self):
  with tempfile.TemporaryDirectory() as root,patch.dict(os.environ,{'TRUTHTRACE_HANDLE_DIR':root,'TRUTHTRACE_HANDLE_MAX_BYTES':'8','TRUTHTRACE_HANDLE_TOTAL_BYTES':'12','TRUTHTRACE_HANDLE_MAX_COUNT':'2','TRUTHTRACE_HANDLE_TTL_SECONDS':'1'}):
   files=HandleFiles();original=Path(root)/'original.json';original.write_text('original')
   first=files.save(b'12345678','a.json')
   with self.assertRaises(ValueError):files.save(b'12345','b.json')
   with self.assertRaises(ValueError):files.save(b'123456789','b.json')
   os.utime(first,(time.time()-5,time.time()-5));files.save(b'12345','b.json');self.assertFalse(Path(first).exists())
   files.remove(str(original));self.assertTrue(original.exists())
 def test_atomic_quota_and_active_read(self):
  with tempfile.TemporaryDirectory() as root,patch.dict(os.environ,{'TRUTHTRACE_HANDLE_DIR':root,'TRUTHTRACE_HANDLE_TOTAL_BYTES':'10','TRUTHTRACE_HANDLE_MAX_COUNT':'1'}):
   a,b=HandleFiles(),HandleFiles();success=[];errors=[]
   def save(manager):
    try:success.append(manager.save(b'12345678','a.json'))
    except ValueError:pass
    except Exception as error:errors.append(type(error).__name__)
   threads=[threading.Thread(target=save,args=(m,)) for m in [a,b]]
   for t in threads:t.start()
   for t in threads:t.join()
   self.assertEqual(errors,[]);self.assertEqual(len(success),1)
 def test_active_reader_prevents_expiry_cleanup(self):
  with tempfile.TemporaryDirectory() as root,patch.dict(os.environ,{'TRUTHTRACE_HANDLE_DIR':root,'TRUTHTRACE_HANDLE_TTL_SECONDS':'1'}):
   reader,writer=HandleFiles(),HandleFiles();path=reader.save(b'old','a.json');os.utime(path,(time.time()-5,time.time()-5));started=threading.Event();finished=threading.Event();errors=[]
   def save():
    started.set()
    try:writer.save(b'new','b.json')
    except Exception as error:errors.append(type(error).__name__)
    finally:finished.set()
   with reader.guard():
    thread=threading.Thread(target=save);thread.start();started.wait(2);self.assertFalse(finished.wait(.2));self.assertTrue(Path(path).exists())
   thread.join(3);self.assertEqual(errors,[]);self.assertTrue(finished.is_set());self.assertFalse(Path(path).exists())
 def test_explicit_local_model_works_without_proxy_or_redirect(self):
  class Echo(BaseHTTPRequestHandler):
   def log_message(self,*args):pass
   def do_POST(self):
    self.rfile.read(int(self.headers['Content-Length']));self.send_response(200);self.end_headers();self.wfile.write(b'{"fixture":true}')
  app=HTTPServer(('127.0.0.1',0),Echo);threading.Thread(target=app.serve_forever,daemon=True).start();origin=f'http://127.0.0.1:{app.server_port}'
  try:
   with patch.dict(os.environ,{'TRUTHTRACE_MODEL_PRIVATE_ORIGINS':origin,'HTTP_PROXY':'http://127.0.0.1:1'}):
    self.assertEqual(OpenAICompatibleClient({'base_url':origin,'api_key':'fixture','timeout':2})._post('chat/completions',{}),{'fixture':True})
  finally:app.shutdown();app.server_close()
 def test_authenticated_health_and_failed_upload_cleanup(self):
  import http.client
  with tempfile.TemporaryDirectory() as root,patch.dict(os.environ,{'TRUTHTRACE_HANDLE_DIR':root,'TRUTHTRACE_INGESTION_TOKEN':'test-only-token'}):
   import server
   from ai_ingest.service import SourceService
   with patch.object(server,'_SOURCE_SVC',SourceService()):
    app=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler);threading.Thread(target=app.serve_forever,daemon=True).start()
    try:
     for auth,status in [('Bearer wrong',401),('Bearer test-only-token',200)]:
      c=http.client.HTTPConnection('127.0.0.1',app.server_port);c.request('GET','/health/auth',headers={'Authorization':auth});r=c.getresponse();self.assertEqual(r.status,status);r.read();c.close()
     body=b'--fixture\r\nContent-Disposition: form-data; name="source"\r\n\r\ninvalid-source\r\n--fixture\r\nContent-Disposition: form-data; name="file"; filename="bad.json"\r\nContent-Type: application/json\r\n\r\ninvalid\r\n--fixture--\r\n'
     c=http.client.HTTPConnection('127.0.0.1',app.server_port);c.request('POST','/source/conversations',body,{'Authorization':'Bearer test-only-token','Content-Type':'multipart/form-data; boundary=fixture'});r=c.getresponse();self.assertEqual(r.status,404);r.read();c.close();self.assertEqual(list(Path(root).glob('tt-*')),[])
    finally:app.shutdown();app.server_close()
if __name__=='__main__':unittest.main()
