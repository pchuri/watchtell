# watchtell

> Describe what to watch in plain language. An agent compiles it **once** into a deterministic checker. A local daemon runs it LLM-free and alerts you **only on state transitions**.

**If a coding agent can check it, you can alarm on it.**

watchtell is a **local-first** alarm tool for macOS: you register arbitrary targets in natural language, a coding-agent CLI compiles each request into a deterministic bash checker a single time, and a local daemon polls it with **zero runtime LLM cost**. It is deliberately *not* a generic web monitor — the point is arbitrary, local, developer-owned checks (HTTP health, JSON thresholds, exchange rates, release tags, process/port liveness, file/command output), not a hosted web-scraping SaaS.

```text
watchtell add "alert me when the exchange rate goes above 1,400"
watchtell add "tell me when service X starts failing health checks"
watchtell add "notify me when repo Y publishes a new release"
```

## Requirements

- **Node.js >= 20** and **macOS** (notifications use `osascript`).
- An installed, already-authenticated agent CLI on your `PATH`: **`claude`** (preferred) or **`codex`**. No API keys — watchtell shells out to the CLI you already use. The agent is called **only** at `add` time; the daemon never calls it.

## Install (from source, until the npm release)

```sh
git clone https://github.com/pchuri/watchtell
cd watchtell
npm install
npm link            # puts `watchtell` on your PATH
```

State lives under `~/.watchtell/` (override with `WATCHTELL_HOME`, used by the tests).

## Commands

| Command | What it does |
|---|---|
| `watchtell add "<request>"` | Compile the request once, print the generated checker + meta, ask **Keep? (y/n)**. On Keep it hash-binds the script and runs one immediate test. `--yes` keeps without review (trusts the generator). |
| `watchtell list` | Show checkers: id, request, interval, route, last state, last fired. |
| `watchtell test <id>` | Force one run now (ignores the schedule) and show the output/transition. Does not send a notification. |
| `watchtell rm <id>` | Delete a checker and its trust record + state sidecar. |
| `watchtell daemon start [--detach]` | Run the internal-loop scheduler (foreground by default; `--detach` backgrounds it). |
| `watchtell daemon stop` / `status` | Stop the daemon / report running / not running / stale-pid. |

## The checker contract

Every generated checker is deterministic bash that:

1. **Runs no LLM at runtime** — only ordinary tools (`curl`, `jq`, `grep`, `awk`, `lsof`, `pgrep`, …).
2. **Is silent by default** — no stdout when nothing alarm-worthy has happened.
3. **Fires on transitions only** — exactly one human-readable line when the watched condition *changes* (ok→failing, below→above a threshold, present→absent, old→new release). It persists the previous state in a sidecar (`$WATCHTELL_STATE`) so the same ongoing condition does not re-alarm every poll; a recovery transition may print one line too.
4. **Never alarms on the first run** — the first observation just records a baseline.
5. **Is timely and fail-safe** — finishes within a hard **30s** timeout; a probe error (network down, missing tool, unparseable output) is *not* an alarm unless the request is specifically about that failure.

Transition dedupe lives inside the checker; the daemon just relays a non-empty line to the notification route.

## The trust model

A generated checker is arbitrary code, so it never runs before you approve it:

- **Keep = hash-bind.** On Keep, watchtell records the SHA-256 of the exact script bytes into a trust record (`<id>.check-trust`).
- **Refuse on mismatch.** The daemon and `watchtell test` **re-hash the script before every run** and refuse to execute — with a clear message, quarantining nothing silently — if the hash mismatches or the trust record is absent. Editing a checker's bytes after Keep disables it until you re-add it.

## Notifications

v0.1 has one route: **`notify`** = macOS Notification Center via `osascript` (no extra dependencies). A checker may compile with a different `route=` (e.g. `slack`); watchtell stores it but reports *"route not yet supported, using notify"* and relays through Notification Center. The Slack webhook plugin is v0.2.

## Development

```sh
npm test          # node:test unit suites (no live LLM, no network)
npm run smoke     # end-to-end happy path with a fixture compiler + mock notifier
```

The smoke script uses a fixture compiler and a mock notifier because sandboxes/CI have no GUI session for real Notification Center; the happy path (add → keep+bind → list → test → daemon fire → rm) is otherwise exercised against the real daemon.

> Work in progress — not yet released. launchd auto-start and Slack routing are planned for v0.2.
