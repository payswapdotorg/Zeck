#!/usr/bin/env python3
import json, re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def load(rel):
    p = ROOT / rel
    return json.loads(p.read_text(encoding='utf-8'))

# Required governance artifacts.
required = [
    'spec/governance/architect.json',
    'spec/governance/worker-protocol.json',
    'spec/governance/assurance-profiles.json',
    'spec/governance/checkpoint-contract.json',
    'spec/development-state/governance-model.json',
    'spec/development-state/program-state.json',
    'spec/development-state/dependency-state.json',
    'spec/development-state/frontier-state.json',
    'spec/development-state/checkpoint-state.json',
]
for rel in required:
    if not (ROOT / rel).exists():
        raise SystemExit(f'missing governance artifact: {rel}')
    load(rel)

program = load('spec/development-state/program-state.json')
deps = load('spec/development-state/dependency-state.json')
lock = (ROOT / 'spec/architecture-lock.md').read_text()
architecture = (ROOT / 'spec/architecture.md').read_text()
worker = load('spec/governance/worker-protocol.json')
architect = load('spec/governance/architect.json')

assert program['governing']['architectureVersion'] == 'v1.0'
assert 'Execution is the primary abstraction' in architecture
assert 'Workers cannot merge their own PRs' in lock
assert 'merge-own-pr' in worker['workerMayNot']
assert 'approve-merge' in architect['decisionRights']
assert (ROOT / '.github/CODEOWNERS').exists()
assert (ROOT / 'docs/work-items/WORK-001.md').exists()
for critical_doc in ['IMPLEMENTATION.md','spec/contracts.md','spec/worker-runbook.md','spec/requirement-traceability.md']:
    assert (ROOT / critical_doc).exists(), f'missing implementation contract: {critical_doc}'
for critical_doc in ['IMPLEMENTATION.md','spec/contracts.md','spec/worker-runbook.md','spec/requirement-traceability.md']:
    assert (ROOT / critical_doc).exists(), f'missing implementation contract: {critical_doc}'
for critical_doc in ['IMPLEMENTATION.md','spec/contracts.md','spec/worker-runbook.md','spec/requirement-traceability.md']:
    assert (ROOT / critical_doc).exists(), f'missing implementation contract: {critical_doc}'
assert worker['mergeAuthority'] == 'architect'

orders = {w['id']: w for w in program['workOrders']}
assert set(orders) == set(deps['dependencies'])

# Dependency closure + acyclicity.
for wid, parents in deps['dependencies'].items():
    for parent in parents:
        assert parent in orders, f'{wid} depends on unknown {parent}'

WHITE, GRAY, BLACK = 0, 1, 2
marks = {w: WHITE for w in orders}
def visit(w):
    if marks[w] == GRAY:
        raise SystemExit(f'dependency cycle detected at {w}')
    if marks[w] == BLACK:
        return
    marks[w] = GRAY
    for p in deps['dependencies'][w]:
        visit(p)
    marks[w] = BLACK
for w in orders:
    visit(w)

# Every canonical Work Order exists and has required protocol headings.
wo_dir = ROOT / 'spec/work-orders'
for wid, record in orders.items():
    p = wo_dir / f'{wid}.md'
    assert p.exists(), f'missing {p}'
    text = p.read_text(encoding='utf-8')
    for heading in ['# Objective','# Dependencies','# Declared Change Surfaces','# Scope Boundaries','# Architecture Invariants','# Acceptance Criteria','# Implementation Requirements','# Checkpoints','# Evidence Contract','# Required Verification','# Completion']:
        assert heading in text, f'{wid} missing {heading}'

# Initial frontier must be exactly those whose dependencies are complete.
complete = {w['id'] for w in program['workOrders'] if w['status'] == 'complete'}
eligible = [w['id'] for w in program['workOrders'] if w['status'] == 'pending' and all(p in complete for p in w['dependencies'])]
frontier = load('spec/development-state/frontier-state.json')['eligible']
assert set(frontier) == set(eligible), f'frontier mismatch: expected {eligible}, got {frontier}'

# Post-merge invariant: if merge evidence appears it must carry complete state.
for w in program['workOrders']:
    if 'mergedAs' in w:
        assert w['status'] == 'complete', f'{w["id"]} has merge evidence but is not complete'


# Frozen requirement traceability must cover every requirement exactly once as a primary owner.
trace = (ROOT / 'spec/requirement-traceability.md').read_text(encoding='utf-8')
req_text = (ROOT / 'spec/requirements.md').read_text(encoding='utf-8')
required_ids = re.findall(r'^- ([A-Z]+-\d+):', req_text, re.M)
for rid in required_ids:
    assert trace.count(f'| {rid} |') == 1, f'requirement {rid} must have exactly one primary owner in traceability'

# Every Work Order must have non-placeholder acceptance criteria and explicit primary requirement ownership.
trace_text = (ROOT / 'spec/requirement-traceability.md').read_text(encoding='utf-8')
owner_ids = {}
for line in trace_text.splitlines():
    if line.startswith('| ') and not line.startswith('| Requirement |') and not line.startswith('|---'):
        parts = [x.strip() for x in line.strip('|').split('|')]
        if len(parts) >= 2:
            owner_ids.setdefault(parts[1], []).append(parts[0])
for wid in orders:
    text = (ROOT / 'spec/work-orders' / f'{wid}.md').read_text(encoding='utf-8')
    assert text.count('# Acceptance Criteria') == 1
    section = text.split('# Acceptance Criteria',1)[1].split('# Implementation Requirements',1)[0]
    assert len(re.findall(r'^\d+\. ', section, re.M)) >= 3, f'{wid} needs concrete acceptance criteria'
    assert '# Requirement IDs' in text
    for rid in owner_ids.get(wid, []):
        assert f'`{rid}`' in text, f'{wid} must declare owned requirement {rid}'


# Frozen requirement traceability must cover every requirement exactly once as a primary owner.
trace = (ROOT / 'spec/requirement-traceability.md').read_text(encoding='utf-8')
req_text = (ROOT / 'spec/requirements.md').read_text(encoding='utf-8')
required_ids = re.findall(r'^- ([A-Z]+-\d+):', req_text, re.M)
for rid in required_ids:
    assert trace.count(f'| {rid} |') == 1, f'requirement {rid} must have exactly one primary owner in traceability'

# Every Work Order must have non-placeholder acceptance criteria and explicit primary requirement ownership.
trace_text = (ROOT / 'spec/requirement-traceability.md').read_text(encoding='utf-8')
owner_ids = {}
for line in trace_text.splitlines():
    if line.startswith('| ') and not line.startswith('| Requirement |') and not line.startswith('|---'):
        parts = [x.strip() for x in line.strip('|').split('|')]
        if len(parts) >= 2:
            owner_ids.setdefault(parts[1], []).append(parts[0])
for wid in orders:
    text = (ROOT / 'spec/work-orders' / f'{wid}.md').read_text(encoding='utf-8')
    assert text.count('# Acceptance Criteria') == 1
    section = text.split('# Acceptance Criteria',1)[1].split('# Implementation Requirements',1)[0]
    assert len(re.findall(r'^\d+\. ', section, re.M)) >= 3, f'{wid} needs concrete acceptance criteria'
    assert '# Requirement IDs' in text
    for rid in owner_ids.get(wid, []):
        assert f'`{rid}`' in text, f'{wid} must declare owned requirement {rid}'

print(f'Governance OK: {len(orders)} Work Orders, frontier={eligible}')
