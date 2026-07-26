# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- **Compile prompt is load-bearing.** `src/compile.js` `COMPILE_PROMPT` is the spike-proven prompt (94.7% no-edit reliability) plus one bash-3.2 portability rule. Generated checkers target **macOS default bash 3.2** — never expand an empty/unset array as `"${arr[@]}"` under `set -u`. Don't retune per category; the single general prompt is the design.
- **Trust boundary (`src/trust.js`).** Keep = SHA-256 of exact script bytes into `<id>.check-trust`. The daemon and `test` re-hash before every run and refuse on mismatch/absence. Any change to a checker's bytes disables it until re-added.
- **Testing without live LLM/network.** Override the compiler with `WATCHTELL_COMPILER_CMD` (see `test/fixtures/fake-compiler.sh`), the notifier with `WATCHTELL_NOTIFY_CMD`, the per-run timeout with `WATCHTELL_TIMEOUT_MS`, and the home with `WATCHTELL_HOME`. `src/daemon.js` `runDue({now, notifyFn})` is the testable scheduler core. `npm test` = `node --test`; `npm run smoke` drives the real daemon.
- **launchd test isolation (`src/launchd.js`).** Exercise install/uninstall through the `opts.platform`/`opts.plistPath`/`opts.launchctlFn` seams; tests must never touch the real `~/Library/LaunchAgents` or call real `launchctl`.
- **Provenance (read-only, outside repo):** scout `data/nlalarm-scout-s1/report.md`, spike `data/watchtell-spike-v1/` under `~/dev/firstmate/`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
