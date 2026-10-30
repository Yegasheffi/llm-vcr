#!/usr/bin/env python3
"""Stream a completion through the proxy with only the Python standard library.

    # terminal 1
    llm-vcr --mode auto

    # terminal 2
    OPENAI_BASE_URL=http://127.0.0.1:8484/openai/v1 python examples/python_client.py

No API key is needed when replaying; while recording, pass OPENAI_API_KEY.
"""
import http.client
import json
import os
import sys
from urllib.parse import urlparse

base = os.environ.get("OPENAI_BASE_URL", "http://127.0.0.1:8484/openai/v1")
url = urlparse(base)
if url.scheme != "http":
    raise SystemExit("This example talks to the local proxy over http.")

headers = {"content-type": "application/json"}
if os.environ.get("OPENAI_API_KEY"):
    headers["authorization"] = f"Bearer {os.environ['OPENAI_API_KEY']}"

payload = json.dumps(
    {
        "model": os.environ.get("MODEL", "gpt-4o-mini"),
        "stream": True,
        "messages": [{"role": "user", "content": "Hello from Python"}],
    }
).encode()

connection = http.client.HTTPConnection(url.hostname, url.port or 80, timeout=120)
connection.request(
    "POST",
    f"{url.path.rstrip('/')}/chat/completions",
    body=payload,
    headers=headers,
)
response = connection.getresponse()
print(f"HTTP {response.status}", file=sys.stderr)
if response.status != 200:
    print(response.read().decode(), file=sys.stderr)
    raise SystemExit(1)

while True:
    chunk = response.read1(4096)
    if not chunk:
        break
    sys.stdout.buffer.write(chunk)
    sys.stdout.buffer.flush()
connection.close()
