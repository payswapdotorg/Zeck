    assert len(re.findall(r"^\d+\. ", criteria, re.M)) >= 3, f"{wid} needs at least three concrete acceptance criteria"
    checkpoint_section = text.split("# Required Checkpoint Contracts", 1)[1].split("# Checkpoints", 1)[0]
    for contract_id in re.findall(r"^- `([^`]+)`", checkpoint_section, re.M):
        assert contract_id in contract_ids, f"{wid} references unknown checkpoint contract {contract_id}"
    dep_line = re.search(r"^Requires:\s*(.*)$", text, re.M)
    expected = ", ".join(record["dependencies"]) if record["dependencies"] else "none"
    assert dep_line and dep_line.group(1).strip() == expected, f"{wid} dependency declaration disagrees with program state"

# Every frozen requirement is represented by exactly one primary owner.
required_ids = re.findall(r"^- ([A-Z]+-\d+):", requirements_text, re.M)
# The requirements catalog is versioned through the repository governance surface.
# Keep this explicit so additions/removals are a deliberate architecture/governance change.
assert len(required_ids) == 72, f"expected 72 frozen requirements, found {len(required_ids)}"
assert len(set(required_ids)) == len(required_ids), "duplicate requirement IDs in requirements.md"
owner_rows = {}
for line in trace_text.splitlines():
    if line.startswith("| ") and not line.startswith("| Requirement |") and not line.startswith("|---"):
        parts = [p.strip() for p in line.strip("|").split("|")]
        if len(parts) >= 2 and re.fullmatch(r"[A-Z]+-\d+", parts[0]):
            owner_rows.setdefault(parts[0], []).append(parts[1])
assert set(owner_rows) == set(required_ids), "requirement traceability does not exactly match requirements.md"
for rid in required_ids:
    assert len(owner_rows[rid]) == 1, f"requirement {rid} must have exactly one primary owner"