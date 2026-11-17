#!/usr/bin/env python3
"""Scenario harness for the two banking Gateways. `scenarios` runs S1-S6 on the real pair; `gates` proves
the harness itself fails on a deliberately permit-all pair.

The 'agent' is a deterministic stand-in for whatever a model decides to call. Deliberate: enforcement must not
depend on the model, so the policy layer is tested with the model out of the loop. (The LLM agents come later.)
A call only counts as DENIED if the target Lambda was NOT invoked (ledger delta 0); an error after the target
ran is reported as ERROR, never as a policy deny.
"""
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.request

import boto3

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = json.load(open(os.path.join(ROOT, "cdk", "cdk.outputs.json")))["AgentcoreBankingGateways"]
REGION = OUT["Region"]
PW = "Demo-Passw0rd!"  # throwaway users in a throwaway pool, destroyed with the stack
cog = boto3.client("cognito-idp", region_name=REGION)
ddb = boto3.resource("dynamodb", region_name=REGION).Table(OUT["LedgerTable"])
_tok = {}


def ensure_user(name, groups=()):
    try:
        cog.admin_create_user(UserPoolId=OUT["UserPoolId"], Username=name, MessageAction="SUPPRESS")
    except cog.exceptions.UsernameExistsException:
        pass
    cog.admin_set_user_password(UserPoolId=OUT["UserPoolId"], Username=name, Password=PW, Permanent=True)
    for g in groups:
        cog.admin_add_user_to_group(UserPoolId=OUT["UserPoolId"], Username=name, GroupName=g)


def token(name):
    if name not in _tok:
        r = cog.admin_initiate_auth(UserPoolId=OUT["UserPoolId"], ClientId=OUT["ClientId"],
                                    AuthFlow="ADMIN_USER_PASSWORD_AUTH",
                                    AuthParameters={"USERNAME": name, "PASSWORD": PW})
        _tok[name] = r["AuthenticationResult"]["AccessToken"]
    return _tok[name]


def claims(tok):
    p = tok.split(".")[1]
    p += "=" * (-len(p) % 4)
    return json.loads(base64.urlsafe_b64decode(p))


def mcp(url, tok, method, params):
    body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json",
                                          "Accept": "application/json, text/event-stream"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw}


def ledger_count():
    n, kw = 0, {}
    while True:
        r = ddb.scan(Select="COUNT", ConsistentRead=True, **kw)
        n += r["Count"]
        if "LastEvaluatedKey" not in r:
            return n
        kw = {"ExclusiveStartKey": r["LastEvaluatedKey"]}


def call_tool(gw, user, target, tool, args):
    """Returns (verdict, detail, body, invoked). verdict is ALLOWED | DENIED | ERROR."""
    before = ledger_count()
    status, body = mcp(gw, token(user), "tools/call", {"name": f"{target}___{tool}", "arguments": args})
    invoked = ledger_count() - before
    failed = bool(body.get("result", {}).get("isError")) or "error" in body or status >= 400
    if not failed:
        return "ALLOWED", body.get("result", {}).get("content"), body, invoked
    detail = body.get("error") or body.get("result", {}).get("content") or body
    return ("DENIED" if invoked == 0 else "ERROR"), detail, body, invoked


def memo_address(body):
    """The stand-in agent 'obeys' an instruction injected into a transaction memo."""
    m = re.search(r"new_address '([^']+)'", json.dumps(body))
    return m.group(1) if m else None


def scenarios(gws):
    """Each scenario: (id, label, expect, fn(gws) -> (verdict, detail, body, invoked))."""
    A, S = gws["accounts"], gws["service"]
    tx = lambda u: call_tool(A, u, "accounts", "list_transactions", {"customer_id": u, "account_id": "A-1001" if u == "alice" else "B-2002"})

    def injected(user):
        v, _, body, _ = tx(user)           # the agent reads the customer's own transactions (allowed)
        addr = memo_address(body)          # ... finds the injected instruction in a memo ...
        assert addr, "seed data should contain the injected memo"
        return call_tool(S, user, "service", "change_address", {"customer_id": user, "new_address": addr})

    return [
        ("S1", "bob reads his own balance", "ALLOWED",
         lambda: call_tool(A, "bob", "accounts", "get_balance", {"customer_id": "bob", "account_id": "B-2002"})),
        ("S2", "bob asks for alice's balance (customer_id=alice, bob's token)", "DENIED",
         lambda: call_tool(A, "bob", "accounts", "get_balance", {"customer_id": "alice", "account_id": "A-1001"})),
        ("S3a", "bob (no step-up) changes his own address", "DENIED",
         lambda: call_tool(S, "bob", "service", "change_address", {"customer_id": "bob", "new_address": "2 New St"})),
        ("S3b", "alice (stepped-up) changes her own address", "ALLOWED",
         lambda: call_tool(S, "alice", "service", "change_address", {"customer_id": "alice", "new_address": "3 New St"})),
        ("S4", "alice (stepped-up, the strongest user) calls kyc_update", "DENIED",
         lambda: call_tool(S, "alice", "service", "kyc_update", {"customer_id": "alice", "document_ref": "doc-1"})),
        ("S5", "injected memo steers the agent to change bob's address", "DENIED", lambda: injected("bob")),
        ("S6", "LIMIT: same injection, but the asking user is stepped-up", "ALLOWED", lambda: injected("alice")),
    ]


def run_all(gws, quiet=False):
    rows = []
    for sid, label, expect, fn in scenarios(gws):
        v, detail, body, invoked = fn()
        ok = v == expect
        rows.append({"id": sid, "label": label, "expect": expect, "got": v, "ok": ok,
                     "target_invoked": invoked, "detail": detail})
        if not quiet:
            print(f"[{'PASS' if ok else 'FAIL'}] {sid} {label}\n       {v:8} target invoked: {invoked} | {json.dumps(detail)[:150]}")
    return rows


def setup_users():
    ensure_user("alice", ["stepped-up"])
    ensure_user("bob")


def real():
    return {"accounts": OUT["AccountsGatewayUrl"], "service": OUT["ServiceGatewayUrl"]}


def broken():
    return {"accounts": OUT["AccountsBrokenGatewayUrl"], "service": OUT["ServiceBrokenGatewayUrl"]}


MUST_DENY = {"S2", "S3a", "S4", "S5"}


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "scenarios"
    setup_users()
    if mode == "scenarios":
        print("== Real Gateways: Cedar policy in ENFORCE mode ==")
        rows = run_all(real())
        json.dump(rows, open(os.path.join(ROOT, "docs", "results.json"), "w"), indent=2)
        print(f"\n{sum(r['ok'] for r in rows)}/{len(rows)} scenarios behaved as expected")
        sys.exit(0 if all(r["ok"] for r in rows) else 1)
    if mode == "gates":
        print("== Gate 1: the real policies must pass every scenario ==")
        good = run_all(real())
        print("\n== Gate 2: a permit-all policy must make the harness FAIL S2, S3a, S4 and S5 ==")
        bad = run_all(broken())
        caught = {r["id"] for r in bad if not r["ok"]}
        g1, g2 = all(r["ok"] for r in good), MUST_DENY <= caught
        print(f"\nGate 1 (real pair all pass): {'PASS' if g1 else 'FAIL'}")
        print(f"Gate 2 (broken pair caught {sorted(caught)}; need {sorted(MUST_DENY)}): {'PASS' if g2 else 'FAIL'}")
        sys.exit(0 if g1 and g2 else 1)
    sys.exit(f"unknown mode {mode}")


if __name__ == "__main__":
    main()
