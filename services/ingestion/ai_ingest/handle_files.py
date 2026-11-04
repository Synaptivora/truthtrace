"""Quota-managed uploaded copies, separate from user-owned channel originals."""
import contextlib
import os
from pathlib import Path
import re
import tempfile
import threading
import time
import uuid

class HandleFiles:
    def __init__(self):
        self.root = Path(os.environ.get('TRUTHTRACE_HANDLE_DIR', str(Path(tempfile.gettempdir()) / 'truthtrace-upload-handles'))).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.local = threading.local()
        self.max_file = self.limit('TRUTHTRACE_HANDLE_MAX_BYTES', 25*1024*1024)
        self.max_total = self.limit('TRUTHTRACE_HANDLE_TOTAL_BYTES', 250*1024*1024)
        self.max_count = self.limit('TRUTHTRACE_HANDLE_MAX_COUNT', 256)
        self.ttl = self.limit('TRUTHTRACE_HANDLE_TTL_SECONDS', 86400)
    def limit(self, name, default):
        return min(default, max(1, int(os.environ.get(name, default))))
    @contextlib.contextmanager
    def guard(self):
        with self.lock:
            if getattr(self.local, 'depth', 0):
                yield
                return
            with (self.root / '.lock').open('a+b') as lock:
                lock.seek(0)
                if os.name == 'nt':
                    import msvcrt
                    lock.seek(0); msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
                else:
                    import fcntl
                    fcntl.flock(lock, fcntl.LOCK_EX)
                self.local.depth = 1
                try:
                    yield
                finally:
                    self.local.depth = 0
                    if os.name == 'nt':
                        lock.seek(0); msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
                    else:
                        fcntl.flock(lock, fcntl.LOCK_UN)
    def owned(self, path):
        p = Path(path)
        return p.parent == self.root and bool(re.fullmatch(r'tt-[a-f0-9]{32}\.[a-z0-9]{1,10}', p.name)) and not p.is_symlink()
    def save(self, data, filename):
        if not data or len(data) > self.max_file:
            raise ValueError('渠道上传大小超限')
        with self.guard():
            files = []
            for p in self.root.iterdir():
                if self.owned(p) and p.is_file():
                    if time.time()-p.stat().st_mtime > self.ttl:
                        p.unlink()
                    else:
                        files.append(p)
            if len(files) >= self.max_count or sum(p.stat().st_size for p in files)+len(data) > self.max_total:
                raise ValueError('渠道上传暂存配额已满')
            ext = Path(filename or '').suffix.lower().lstrip('.')
            if not re.fullmatch('[a-z0-9]{1,10}', ext): ext = 'json'
            p = self.root / ('tt-'+uuid.uuid4().hex+'.'+ext)
            try:
                with p.open('xb') as output: output.write(data)
            except BaseException:
                p.unlink(missing_ok=True)
                raise
            return str(p)
    def touch(self, path):
        if path and self.owned(path) and Path(path).is_file(): os.utime(path, None)
    def remove(self, path):
        with self.guard():
            if path and self.owned(path): Path(path).unlink(missing_ok=True)

def guarded_handles(method):
    def wrapper(self, *args, **kwargs):
        with self._handle_files.guard():
            handle = kwargs.get('handle')
            if handle: self._handle_files.touch(self._handles.get(handle))
            return method(self, *args, **kwargs)
    return wrapper
