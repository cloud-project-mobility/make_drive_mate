"""Offline ALB-header regression; run manually inside the reviewed container image."""
import base64
import json
import os
from pathlib import Path
import signal
import socket
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, '/opt/drivemate/container')
from runtime import publish_web

report = {'ok': False}
processes = []
sockets = []
FORWARDED_HEADERS = {'X-Forwarded-Proto': 'http', 'X-Forwarded-Port': '80'}


def request(route, method='GET', token=None, body=None, extra_headers=None):
    headers = {'Host': 'smoke.example.test', 'Origin': 'https://smoke.example.test'}
    headers.update(FORWARDED_HEADERS)
    headers.update(extra_headers or {})
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if body is not None:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request('http://127.0.0.1:8080/api/v1' + route,
        data=None if body is None else json.dumps(body).encode(), method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=8) as response:
        return json.loads(response.read())


def receive(stream):
    def exact(count):
        content = b''
        while len(content) < count:
            chunk = stream.recv(count - len(content))
            if not chunk:
                raise ValueError('socket_closed')
            content += chunk
        return content
    header = exact(2)
    assert header[0] & 15 == 1 and not header[1] & 128
    length = header[1] & 127
    if length == 126:
        length = struct.unpack('!H', exact(2))[0]
    assert length < 4096
    return json.loads(exact(length))


def send(stream, value):
    content = json.dumps(value).encode()
    mask = os.urandom(4)
    header = bytes((0x81, 128 | len(content))) if len(content) < 126 else bytes((0x81, 128 | 126)) + struct.pack('!H', len(content))
    stream.sendall(header + mask + bytes(value ^ mask[index % 4] for index, value in enumerate(content)))


def connect(token):
    ticket = request('/location/ticket', 'POST', token)['ticket']
    stream = socket.create_connection(('127.0.0.1', 8080), timeout=5)
    sockets.append(stream)
    headers = ['GET /api/v1/location/stream HTTP/1.1', 'Host: smoke.example.test',
               'Origin: https://smoke.example.test', 'Upgrade: websocket', 'Connection: Upgrade',
               'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: ' + base64.b64encode(os.urandom(16)).decode(),
               'Sec-WebSocket-Protocol: drivemate.location.v1, ticket.' + ticket, '', '']
    headers[-2:-2] = [f'{name}: {value}' for name, value in FORWARDED_HEADERS.items()]
    stream.sendall('\r\n'.join(headers).encode())
    response = b''
    while not response.endswith(b'\r\n\r\n'):
        response += stream.recv(1)
        assert len(response) < 8192
    assert response.startswith(b'HTTP/1.1 101') and b'Sec-WebSocket-Protocol: drivemate.location.v1' in response
    ready = receive(stream)
    assert ready['type'] == 'ready'
    return stream, ready['source_id']



def main():
    try:
        report['uid'] = os.getuid()
        assert report['uid'] == 10001
        for label, directory in [('runtime', '/opt/drivemate/runtime'), ('web', '/srv/drivemate-web'), ('tmp', '/tmp')]:
            target = Path(directory) / 'write-probe'
            target.write_text('synthetic')
            target.unlink()
            report[label + '_writable'] = True
        assert not os.access('/opt/drivemate/backend-spring/target/drivemate-api-0.2.0.jar', os.W_OK)
        report['baked_code_readonly'] = True
        publish_web(Path('/opt/drivemate'), Path('/srv/drivemate-web'))
        env = dict(os.environ)
        env.update({'SERVER_ADDRESS': '127.0.0.1', 'SERVER_PORT': '18085',
                    'SERVER_FORWARD_HEADERS_STRATEGY': 'framework', 'DRIVEMATE_PROVIDER_MODE': 'mock',
                    'SPRING_SQL_INIT_MODE': 'always',
                    'SPRING_DATASOURCE_URL': 'jdbc:h2:mem:containersmoke;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1',
                    'SPRING_DATASOURCE_USERNAME': 'sa', 'SPRING_DATASOURCE_PASSWORD': ''})
        log = open('/tmp/synthetic-spring.log', 'wb')
        api = subprocess.Popen(['/usr/bin/java', '-Xmx384m', '-jar', '/opt/drivemate/backend-spring/target/drivemate-api-0.2.0.jar'], env=env, stdout=log, stderr=log)
        processes.append(api)
        for _ in range(100):
            if subprocess.run(['/opt/drivemate/venv/bin/python', '/opt/drivemate/container/healthcheck.py', 'api'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                break
            assert api.poll() is None
            time.sleep(.3)
        else:
            raise ValueError('spring_timeout')
        report['spring_health'] = True
        for name in ('client', 'proxy', 'fastcgi', 'uwsgi', 'scgi'):
            Path('/tmp/drivemate-nginx', name).mkdir(parents=True, exist_ok=True)
        subprocess.run(['/usr/sbin/nginx', '-t', '-c', '/opt/drivemate/container/nginx.conf'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        nginx = subprocess.Popen(['/usr/sbin/nginx', '-c', '/opt/drivemate/container/nginx.conf', '-g', 'daemon off;'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        processes.append(nginx)
        for _ in range(30):
            if subprocess.run(['/opt/drivemate/venv/bin/python', '/opt/drivemate/container/healthcheck.py', 'nginx'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                break
            assert nginx.poll() is None
            time.sleep(.2)
        else:
            raise ValueError('nginx_timeout')
        report['nginx_health'] = True
        with urllib.request.urlopen('http://127.0.0.1:8080/', timeout=5) as response:
            assert response.status == 200 and len(response.read()) > 100
        report['baked_web_served'] = True
        assert request('/health')['status'] == 'ok'
        report['health_with_alb_port_80'] = True
        FORWARDED_HEADERS['Forwarded'] = 'proto=http;host=spoofed.example.test'
        assert request('/health')['status'] == 'ok'
        report['health_with_spoofed_forwarded'] = True
        try:
            request('/health', extra_headers={'Origin': 'https://other.example.test'})
            raise AssertionError('foreign_origin_accepted')
        except urllib.error.HTTPError as error:
            assert error.code == 403
        report['foreign_origin_rejected'] = True
        first = request('/auth/register', 'POST', body={'email': 'synthetic-a@example.test', 'password': 'synthetic-pass-a-2026'})
        second = request('/auth/register', 'POST', body={'email': 'synthetic-b@example.test', 'password': 'synthetic-pass-b-2026'})
        report['post_with_alb_and_spoofed_headers'] = True
        sender, source = connect(first['access_token'])
        receiver, _ = connect(first['access_token'])
        outsider, _ = connect(second['access_token'])
        instant = datetime.now(timezone.utc).isoformat()
        send(sender, {'type': 'position', 'latitude': 37.54321, 'longitude': 127.12345, 'accuracy_m': 8, 'observed_at': instant})
        point = receive(receiver)
        assert point['type'] == 'position' and point['source_id'] == source and point['latitude'] == 37.54321
        outsider.settimeout(.75)
        try:
            assert not outsider.recv(1), 'cross_account_event'
        except TimeoutError:
            pass
        send(sender, {'type': 'stop'})
        stopped = receive(receiver)
        assert stopped['type'] == 'stopped' and stopped['source_id'] == source
        report['nginx_websocket_relay'] = True
        report['websocket_with_alb_and_spoofed_headers'] = True
        report['cross_account_position_count'] = 0
        report['websocket_stop'] = True
        report['ok'] = True
    except Exception as error:
        report['error_type'] = type(error).__name__
        if isinstance(error, urllib.error.HTTPError):
            report['http_status'] = error.code
    finally:
        for stream in sockets:
            stream.close()
        for process in reversed(processes):
            process.send_signal(signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        print(json.dumps(report), flush=True)
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
