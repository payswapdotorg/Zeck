# Zeck — Post-Release User-Journey Simulation

**Date:** 2026-09-20  
**Baseline:** `faa024247546e61d6e52465b1929188230f0feb6`  
**Method:** repository-backed simulation of the current console and machine contracts, plus inspection of the live ShareNet Conformance design reference. No live Zeck URL was verified during this pass.

## Major findings

### 1. Discovery
The current home is already outcome-first, but the navigation quickly exposes internal concepts. A newcomer should first see what Zeck can do and how to try it.

**Change:** discovery-first home with capability catalog and “Start sandbox”.

### 2. First execution
The current sandbox path is governed and technically complete, but it assumes knowledge of application/environment concepts.

**Change:** guided disposable setup before the first task.

### 3. Capability discovery
The machine manifest provides **22 workload families** with explicit runnable/provider-gated states. The capability system is stronger than its current discoverability.

**Change:** make capabilities first-class.

### 4. Execution inspection
The execution explorer is already one of the strongest surfaces.

**Change:** elevate “How Zeck did it” from advanced inspection to standard result comprehension.

### 5. Validation
Validation Lab is technically complete and evidence-backed.

**Change:** make it a normal destination from discovery/results rather than an advanced feature.

### 6. Economics and comparison
Usage, economics, compare and export exist.

**Change:** link these directly from result pages.

### 7. Trust
Policy, spend, sandbox and verification exist but are distributed.

**Change:** consolidate discovery into “Trust & Limits” while retaining existing authorities.

### 8. Agents
Machine-readable documentation already exists.

**Change:** make “For agents” a first-class onboarding path.

### 9. Safety
Sandbox governance is strong.

**Change:** show limits and synthetic-data rules before the run begins.

### 10. Deployment
The deployment recipe is complete, but there is still no verified public Zeck instance.

**Change:** activate a real preview and expose a Deployment Center.

### 11. Mobile
Responsive/a11y hardening is already present.

**Change:** simplify the visible mobile hierarchy using ShareNet's calmer navigation grammar.

### 12. Honest availability
Provider-gated and NOT RUN states are handled honestly.

**Change:** surface those states earlier rather than making users discover them only after entering a deep route.

## Resulting experience model

```
Understand
→ Capability
→ Safe sandbox
→ Execution
→ How Zeck did it
→ Validation
→ Compare / Reproduce
→ Trust & Limits
→ Agent integration
→ Deployment
```

