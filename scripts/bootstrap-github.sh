#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-pectoraux/ai-execution-os}"
VISIBILITY="${VISIBILITY:-public}"

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is required for remote creation. Install it and run 'gh auth login'." >&2
  exit 1
fi

gh auth status >/dev/null

if gh repo view "$REPO" >/dev/null 2>&1; then
  echo "Remote repository already exists: $REPO"
else
  gh repo create "$REPO" --"$VISIBILITY" --description "AI Execution OS — governed, provider-independent AI execution infrastructure" --source=. --remote=origin --push
  echo "Created and pushed $REPO"
fi
