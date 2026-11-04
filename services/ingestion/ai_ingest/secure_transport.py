"""Pinned, non-redirecting model transport. Never includes upstream errors in exceptions."""
import http.client
import ipaddress
import json
import os
import socket
import ssl
from urllib.parse import urlsplit

def public_address(value):
    address = ipaddress.ip_address(value)
    if not address.is_global:
        return False
    if address.version == 6:
        return address in ipaddress.ip_network('2000::/3') and not any(address in ipaddress.ip_network(net) for net in ('2001::/23', '2002::/16', '3fff::/20'))
    return True

def post_json(config, path, body):
    connection = None
    try:
        url = urlsplit(config['base_url'].rstrip('/') + '/' + path)
        port = url.port or (443 if url.scheme == 'https' else 80)
        host = url.hostname
        origin = f'{url.scheme}://{url.netloc}'
        allowed = origin in {x.strip() for x in os.environ.get('TRUTHTRACE_MODEL_PRIVATE_ORIGINS', '').split(',') if x.strip()}
        if not host or url.username or url.password or url.query or url.fragment or not (url.scheme == 'https' or allowed and url.scheme == 'http'):
            raise ValueError()
        addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        if not addresses or not allowed and any(not public_address(a[4][0]) for a in addresses):
            raise ValueError()
        family, kind, protocol, _, address = addresses[0]
        timeout = min(60, max(1, float(config.get('timeout', 60))))
        # Resolve once; connect to the exact authorized sockaddr, preserving TLS SNI.
        sock = socket.socket(family, kind, protocol)
        try:
            sock.settimeout(timeout)
            sock.connect(address)
            if url.scheme == 'https':
                sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
            connection = http.client.HTTPConnection(host, port, timeout=timeout)
            connection.sock = sock
            connection.request('POST', url.path or '/', json.dumps(body, ensure_ascii=False).encode(), {'Content-Type':'application/json', 'Authorization':'Bearer ' + config['api_key']})
            response = connection.getresponse()
            if not 200 <= response.status < 300:
                raise ValueError()
            raw = response.read(8 * 1024 * 1024 + 1)
            if len(raw) > 8 * 1024 * 1024:
                raise ValueError()
            return json.loads(raw)
        finally:
            sock.close()
    except Exception:
        raise RuntimeError('模型连接失败、目的地址未授权或响应无效') from None
    finally:
        if connection:
            connection.close()
