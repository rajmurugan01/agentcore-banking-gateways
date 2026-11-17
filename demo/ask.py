#!/usr/bin/env python3
"""Send one customer message to the Coordinator Runtime as a signed-in user. Usage: ask.py <user> "<message>" """
import json
import sys
import time
import urllib.parse
import urllib.request
from uuid import uuid4

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import run as h  # noqa: E402  (reuses user setup, token and outputs)

META = "<<META>>"


def ask(user, text, timeout=180, session=None):
    arn = h.OUT["CoordinatorRuntimeArn"]
    url = f"https://bedrock-agentcore.{h.REGION}.amazonaws.com/runtimes/{urllib.parse.quote(arn, safe='')}/invocations?qualifier=DEFAULT"
    env = {"jsonrpc": "2.0", "id": "1", "method": "message/send",
           "params": {"message": {"role": "user", "parts": [{"kind": "text", "text": text}], "messageId": str(uuid4()),
                                   **({"metadata": {"session_hint": session}} if session else {})}}}
    req = urllib.request.Request(url, data=json.dumps(env).encode(), method="POST", headers={
        "Authorization": f"Bearer {h.token(user)}", "Content-Type": "application/json", "Accept": "application/json",
        "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": ((session + "-coord-") if session else str(uuid4()) + "-").ljust(40, "x")})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"error": e.code, "raw": e.read().decode()[:600], "e2e_ms": int((time.time() - t0) * 1000)}
    parts = (body.get("result") or {}).get("parts") or ((body.get("result") or {}).get("message") or {}).get("parts", [])
    reply = "\n".join(p.get("text", "") for p in parts if isinstance(p, dict))
    meta = {}
    if META in reply:
        reply, raw = reply.split(META, 1)
        meta = json.loads(raw)
    return {"reply": reply.strip(), "meta": meta, "e2e_ms": int((time.time() - t0) * 1000)}


if __name__ == "__main__":
    h.setup_users()
    out = ask(sys.argv[1], sys.argv[2])
    print(json.dumps(out, indent=2))
