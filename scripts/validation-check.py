#!/usr/bin/env python3
"""validation-check.py — governance check for the Zeck validation program.

VAL-001: a standalone, deterministic check of the governed validation
state (`spec/validation-state/*`) mirroring the mechanical consistency
rules the CI suite enforces (tests/unit/validation/). Exit 0 = the
validation program state is consistent; exit 1 = violations (printed).

This script is read-only: it never mutates state, never touches product
or development-state authority, and reads no secrets.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
STATE_DIR = REPO_ROOT / "spec" / "validation-state"
WO_DIR = REPO_ROOT / "spec" / "validation-work-orders"


def load(name: str) -> dict:
    path = STATE_DIR / name
    if not path.exists():
        print(f"VALIDATION FAIL: missing state file {STATE_DIR / name}")
        sys.exit(1)
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def check(program: dict, frontier: dict, dependencies: dict) -> list[str]:
    violations: list[str] = []
    programs = {program.get("program"), frontier.get("program"), dependencies.get("program")}
    if len(programs) != 1 or None in programs:
        violations.append(f"program identifiers disagree: {sorted(str(p) for p in programs)}")
    if program.get("maxConcurrentWorkers") != frontier.get("maxConcurrentWorkers"):
        violations.append(
            "maxConcurrentWorkers disagrees between program and frontier state"
        )
    if frontier.get("maxConcurrentWorkers") != 3:
        violations.append(
            f"the roadmap fixes maxConcurrentWorkers at 3, frontier declares "
            f"{frontier.get('maxConcurrentWorkers')}"
        )
    if program.get("status") != frontier.get("status"):
        violations.append(
            f"program status {program.get('status')} != frontier status {frontier.get('status')}"
        )

    known = set(program.get("workOrders", {}))
    dep_map: dict[str, list[str]] = dependencies.get("dependencies", {})

    for id_ in list(frontier.get("inFlight", [])) + list(frontier.get("eligible", [])) + list(
        frontier.get("blocked", [])
    ):
        if id_ not in known:
            violations.append(f"frontier references unknown work order {id_}")
    for id_ in known:
        if id_ not in dep_map:
            violations.append(f"program state declares {id_} but dependency state has no entry")
    for id_, deps in dep_map.items():
        if id_ not in known:
            violations.append(f"dependency state declares {id_} but program state does not")
        for dep in deps:
            if dep not in known:
                violations.append(f"{id_} depends on unknown {dep}")

    def has_cycle(start: str, seen: set[str]) -> bool:
        if start in seen:
            return True
        seen = seen | {start}
        return any(has_cycle(dep, seen) for dep in dep_map.get(start, []))

    for id_ in dep_map:
        if has_cycle(id_, set()):
            violations.append(f"dependency cycle reachable from {id_}")

    for id_ in frontier.get("inFlight", []):
        status = program.get("workOrders", {}).get(id_, {}).get("status")
        if status == "planned":
            violations.append(f"{id_} is in flight but program state still declares it planned")
    for id_ in frontier.get("eligible", []):
        if id_ in frontier.get("inFlight", []):
            violations.append(f"{id_} is both eligible and in flight")
    if len(frontier.get("inFlight", [])) > frontier.get("maxConcurrentWorkers", 0):
        violations.append(
            f"{len(frontier.get('inFlight', []))} work orders in flight exceeds the ceiling"
        )

    def complete(id_: str) -> bool:
        return program.get("workOrders", {}).get(id_, {}).get("status") == "complete"

    for id_ in list(frontier.get("inFlight", [])) + list(frontier.get("eligible", [])):
        for dep in dep_map.get(id_, []):
            if not complete(dep):
                violations.append(
                    f"{id_} is eligible/in-flight but dependency {dep} is not complete"
                )

    # Spec files exist for every DISPATCHED work order (in flight or
    # eligible); planned work orders receive their spec at Architect
    # authorization time, so a missing spec there is not a violation.
    for id_ in list(frontier.get("inFlight", [])) + list(frontier.get("eligible", [])):
        spec = WO_DIR / f"{id_}.md"
        if not spec.exists():
            violations.append(
                f"dispatched work order {id_} has no spec file under spec/validation-work-orders"
            )
    return violations


def main() -> int:
    program = load("program-state.json")
    frontier = load("frontier-state.json")
    dependencies = load("dependency-state.json")
    violations = check(program, frontier, dependencies)
    if violations:
        for violation in violations:
            print(f"VALIDATION FAIL: {violation}")
        return 1
    count = len(program.get("workOrders", {}))
    in_flight = ", ".join(frontier.get("inFlight", [])) or "none"
    eligible = ", ".join(frontier.get("eligible", [])) or "none"
    print(
        f"Validation OK: {count} validation work orders, "
        f"inFlight=[{in_flight}], eligible=[{eligible}]"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
