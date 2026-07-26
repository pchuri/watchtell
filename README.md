# watchtell

> Describe what to watch in plain language. An agent compiles it **once** into a deterministic checker. A local daemon runs it LLM-free and alerts you **only on state transitions**.

**If a coding agent can check it, you can alarm on it.**

```text
watchtell add "alert me on Slack when the exchange rate goes above 1,400"
watchtell add "tell me when service X starts failing health checks"
watchtell add "notify me when repo Y publishes a new release"
```

- **Ask, don't configure** - no rule builders, no integration catalogs.
- **Compile once, run free** - the LLM writes the checker at registration; runtime is deterministic, local, and costs nothing.
- **Quiet by design** - checkers stay silent until state actually changes; you are alerted on transitions, not on every poll.
- **Keep / Undo** - review the generated checker diff before it is trusted to run.

> Work in progress - not yet released.
