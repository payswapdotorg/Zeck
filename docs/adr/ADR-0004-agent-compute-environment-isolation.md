# ADR-0004 — Agent Compute Environment Isolation

**Status:** Accepted

Agents do not receive ambient host access. They receive a provider-independent ComputeEnvironment selected according to capability, risk and policy. Containers are the initial general-purpose runtime; microVM/VM and customer-runner variants are architectural extensions.
