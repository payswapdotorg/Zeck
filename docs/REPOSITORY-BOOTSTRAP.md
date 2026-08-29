# Remote Repository Bootstrap

This local repository is fully initialized and validated. The execution environment used for this bootstrap does not expose an authenticated GitHub repository-creation operation, so remote creation is kept as an explicit one-command handoff rather than pretending it occurred.

From this directory, on a machine with GitHub CLI authentication:

```bash
gh auth login
gh repo create pectoraux/ai-execution-os --public --description "AI Execution OS — governed, provider-independent AI execution infrastructure" --source=. --remote=origin --push
```

After remote creation, protect `main` with the architect/reviewer policy and require the governance workflow to pass before merge.
