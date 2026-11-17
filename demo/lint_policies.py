#!/usr/bin/env python3
"""Offline policy lint, runs in CI with no AWS access.

Checks the REAL policies for the shapes that would silently open a Gateway, and checks the permit-all
fixture still trips the same check (so this lint cannot quietly stop working).
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent / "policies"
# An unconstrained action list on a permit: `action,` or `action)` with no `==` / `in`.
UNCONSTRAINED = re.compile(r"permit\s*\([^;]*?\baction\s*[,)]", re.S)


def unconstrained(text: str) -> bool:
    return bool(UNCONSTRAINED.search(text))


def main() -> int:
    bad = [p.name for p in sorted(ROOT.glob("*.cedar")) if unconstrained(p.read_text())]
    fixture = (ROOT / "fixtures" / "permit-all.cedar").read_text()
    if not unconstrained(fixture):
        print("FAIL: the permit-all fixture no longer trips the lint, the lint is broken")
        return 1
    if bad:
        print(f"FAIL: unconstrained permit in {bad}")
        return 1
    kyc = (ROOT / "service-kyc-forbid.cedar").read_text()
    if "forbid" not in kyc or "service___kyc_update" not in kyc:
        print("FAIL: kyc_update forbid is missing")
        return 1
    print(f"ok: {len(list(ROOT.glob('*.cedar')))} policies clean, fixture still trips the lint")
    return 0


if __name__ == "__main__":
    sys.exit(main())
