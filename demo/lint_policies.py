#!/usr/bin/env python3
"""Offline policy lint, runs in CI with no AWS access.

Rule: every permit in a REAL policy must bind the tool's customer_id argument to the verified token's username.
The broken fixtures must violate that rule, so the lint cannot quietly stop working. A permit that mentions
kyc_update in a real policy is also a failure (human-only tool stays default-deny).
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent / "policies"
OWNER = 'context.input.customer_id == principal.getTag("username")'


def permits_without_owner_check(text):
    stmts = [s for s in re.split(r"(?=\bpermit\s*\()", text) if s.lstrip().startswith("permit")]
    return [s for s in stmts if OWNER not in s]


def main():
    real = sorted(ROOT.glob("*.cedar"))
    bad = [p.name for p in real if permits_without_owner_check(p.read_text())]
    fixtures = sorted((ROOT / "fixtures").glob("*.cedar"))
    if len(list((ROOT / "fixtures").glob("*.cedar"))) < 2:
        print("FAIL: expected two broken fixtures")
        return 1
    silent = [p.name for p in fixtures if not permits_without_owner_check(p.read_text())]
    if silent:
        print(f"FAIL: fixtures no longer trip the lint, the lint is broken: {silent}")
        return 1
    if bad:
        print(f"FAIL: permit without an owner check in {bad}")
        return 1
    if any("service___kyc_update" in p.read_text() and "permit" in p.read_text() for p in real):
        print("FAIL: a real permit mentions kyc_update; it must stay default-deny")
        return 1
    print(f"ok: {len(real)} real policies bind customer_id to the token, {len(fixtures)} fixtures still trip the lint")
    return 0


if __name__ == "__main__":
    sys.exit(main())
