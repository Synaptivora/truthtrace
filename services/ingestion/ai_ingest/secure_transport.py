"""Pinned, non-redirecting model transport. Never includes upstream errors in exceptions."""
import http.client
import ipaddress
import json
import os
import socket
import ssl
import threading
import time
import queue
from urllib.parse import urlsplit

_DNS_SLOTS = threading.BoundedSemaphore(8)

def public_address(value):
    address = ipaddress.ip_address(value)
    if not address.is_global:
        return False
    if address.version == 6:
        return address in ipaddress.ip_network('2000::/3') and not any(address in ipaddress.ip_network(net) for net in ('2001::/23', '2002::/16', '3fff::/20'))
    return True

def post_json(config, path, body):
    connection = None
    timer = None
    deadline = time.monotonic() + min(60, max(1, float(config.get("timeout", 60))))
    try:
        url = urlsplit(config['base_url'].rstrip('/') + '/' + path)
        port = url.port or (443 if url.scheme == 'https' else 80)
        host = url.hostname
        origin = f'{url.scheme}://{url.netloc}'
        allowed = origin in {x.strip() for x in os.environ.get('TRUTHTRACE_MODEL_PRIVATE_ORIGINS', '').split(',') if x.strip()}
        if not host or url.username or url.password or url.query or url.fragment or not (url.scheme == 'https' or allowed and url.scheme == 'http'):
            raise ValueError()
        if not _DNS_SLOTS.acquire(timeout=max(0, deadline-time.monotonic())): raise TimeoutError()
        resolved = queue.Queue(maxsize=1)
        def resolve():
            try: resolved.put((socket.getaddrinfo(host, port, type=socket.SOCK_STREAM), None))
            except Exception as error: resolved.put((None, error))
            finally: _DNS_SLOTS.release()
        threading.Thread(target=resolve, daemon=True).start()
        addresses, error = resolved.get(timeout=max(.001, deadline-time.monotonic()))
        if error: raise error
        if not addresses or not allowed and any(not public_address(a[4][0]) for a in addresses):
            raise ValueError()
        family, kind, protocol, _, address = addresses[0]
        timeout = deadline-time.monotonic()
        if timeout <= 0: raise TimeoutError()
        # Resolve once; connect to the exact authorized sockaddr, preserving TLS SNI.
        sock = socket.socket(family, kind, protocol)
        socket_lock = threading.Lock()
        def expire():
            with socket_lock:
                try: sock.shutdown(socket.SHUT_RDWR)
                except OSError: pass
                sock.close()
        timer = threading.Timer(timeout, expire)
        timer.daemon = True
        timer.start()
        try:
            sock.settimeout(timeout)
            sock.connect(address)
            if url.scheme == 'https':
                context = ssl.create_default_context()
                # Publish the TLS socket before any blocking handshake. The timer must never
                # observe the detached plain socket during the ownership transfer.
                with socket_lock:
                    if time.monotonic() >= deadline: raise TimeoutError()
                    sock = context.wrap_socket(sock, server_hostname=host, do_handshake_on_connect=False)
                sock.do_handshake()
            connection = http.client.HTTPConnection(host, port, timeout=timeout)
            connection.sock = sock
            connection.request('POST', url.path or '/', json.dumps(body, ensure_ascii=False).encode(), {'Content-Type':'application/json', 'Authorization':'Bearer ' + config['api_key']})
            response = connection.getresponse()
            if not 200 <= response.status < 300:
                raise ValueError()
            raw = response.read(8 * 1024 * 1024 + 1)
            if len(raw) > 8 * 1024 * 1024:
                raise ValueError()
            result = json.loads(raw)
            if time.monotonic() >= deadline: raise TimeoutError()
            return result
        finally:
            sock.close()
    except Exception:
        raise RuntimeError('模型连接失败、目的地址未授权或响应无效') from None
    finally:
        if timer: timer.cancel()
        if connection:
            connection.close()
