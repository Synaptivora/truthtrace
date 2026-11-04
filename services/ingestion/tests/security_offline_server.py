"""Offline HTTP fixture: never probe installed channel clients."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parents[1]))
import server
from ai_ingest.service import SourceService
original = SourceService._probe
def offline_probe(self, sid):
    if sid == 'mock':
        return original(self, sid)
    return {'authorized': False, 'status': 'not_connected', 'detail': 'offline fixture', 'action': '', 'hint': ''}
SourceService._probe = offline_probe
server.main()
