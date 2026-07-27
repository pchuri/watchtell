# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- **Compile prompt is load-bearing.** `src/compile.js` `COMPILE_PROMPT` is the spike-proven prompt (94.7% no-edit reliability) plus one bash-3.2 portability rule. Generated checkers target **macOS default bash 3.2** — never expand an empty/unset array as `"${arr[@]}"` under `set -u`. Don't retune per category; the single general prompt is the design.
- **Trust boundary (`src/trust.js`).** Keep = SHA-256 of exact script bytes into `<id>.check-trust`. The daemon and `test` re-hash before every run and refuse on mismatch/absence. Any change to a checker's bytes disables it until re-added.
- **ASCII-confusable gate (`src/compile.js` `lintConfusables`).** Keep it a whole-file scan of the small explicit lookalike list, not a non-ASCII ban; run it after `parse` and before Keep/hash-binding, at add time only. See `test/compile.test.js` for the accepted Unicode and retry/failure invariants.
- **rm-vs-run race (`src/store.js` + `src/daemon.js`).** `store.remove` writes a `<id>.removed` **tombstone before** deleting sidecars and leaves it behind; `commitRuntime` checks it before and after daemon runtime writes, while `sweepRemoved` and the per-run guards reap removed state sidecars and runtime records (including pending alarms) without error spam. `newId` skips tombstoned ids so a recycled id is never swept as the removed one. Tests: `test/rm-race.test.js`.
- **Testing without live LLM/network.** Override the compiler with `WATCHTELL_COMPILER_CMD` (see `test/fixtures/fake-compiler.sh`), the notifier with `WATCHTELL_NOTIFY_CMD`, the per-run timeout with `WATCHTELL_TIMEOUT_MS`, and the home with `WATCHTELL_HOME`. `src/daemon.js` `runDue({now, notifyFn})` is the testable scheduler core. `npm test` = `node --test`; `npm run smoke` drives the real daemon.
- **launchd test isolation (`src/launchd.js`).** Exercise install/uninstall through the `opts.platform`/`opts.plistPath`/`opts.launchctlFn` seams; tests must never touch the real `~/Library/LaunchAgents` or call real `launchctl`.
- **Coding-agent skill (`skills/watchtell/SKILL.md`).** Installer-facing Agent Skill for handing watches off to the daemon. It defers to `watchtell --help` for the command surface but hard-codes command names, flags, and output strings (`meta: interval=`, `silent (no transition)`, daemon subcommands). **When CLI commands/flags/output change, update `skills/watchtell/SKILL.md`** (`test/skill.test.js` guards its frontmatter + command mentions).
- **Provenance (read-only, outside repo):** scout `data/nlalarm-scout-s1/report.md`, spike `data/watchtell-spike-v1/` under `~/dev/firstmate/`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
