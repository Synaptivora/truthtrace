"""Service credentials used only by local HTTP regression fixtures."""
import os
import urllib.request
os.environ['TRUTHTRACE_INGESTION_TOKEN'] = 'offline-regression-token'
class LocalServiceAuth(urllib.request.BaseHandler):
    def http_request(self, request):
        if request.host.split(':')[0] in ('127.0.0.1', 'localhost'):
            request.add_header('Authorization', 'Bearer offline-regression-token')
        return request
urllib.request.install_opener(urllib.request.build_opener(LocalServiceAuth()))
