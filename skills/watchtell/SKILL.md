---
name: watchtell
description: >-
  Hand off long-lived watching to watchtell, a macOS-local natural-language alarm daemon, when the user
  wants to be notified the moment something changes in the future and that change may land after this
  coding session ends — e.g. "tell me when this CI goes red", "alert me when this dependency publishes a
  new release", "notify me when this endpoint starts 5xx-ing", "ping me when this board gets a new post".
  watchtell compiles the request into a deterministic bash checker ONCE (via the local claude/codex CLI),
  then a local daemon polls it LLM-free and fires a macOS notification only on state TRANSITIONS. Use for
  developer-owned checks on a Mac: HTTP health, JSON thresholds, release tags, exchange rates, new list
  items, process/port liveness, file/command output. NOT a general web-scraping monitor, NOT for
  sub-minute polling, NOT for team/headless/remote/CI use.
---

# watchtell — hand off a watch to the daemon

watchtell lets you register "alarm on X" in plain language. Your local `claude`/`codex` CLI compiles the
request into a deterministic bash **checker** once, at registration. A local daemon then polls that
checker with **zero runtime LLM cost** and sends a **macOS notification only when the watched condition
transitions** (ok→failing, below→above, absent→present, old→new). Your session ends; the daemon persists.
That is the whole value: hand off watching you cannot keep doing yourself.

Reach for this when the user says "let me know / tell me / alert me / notify me / ping me **when**
<something changes later>" and the change may happen after this chat ends. Do NOT reach for it for a
one-off check you can do right now (just do the check).

## 0. Command surface (authoritative: `watchtell --help` and `watchtell <cmd> --help`)

| Command | Use |
|---|---|
| `watchtell add "<request>" --yes` | Compile the request, print the generated checker + meta, keep it, hash-bind it, run one immediate (silent, no-notification) test. `--yes` skips the interactive keep prompt — required for non-interactive agent use. Add `--interval <duration>` (`600`, `90s`, `5m`, `1h`) to set the poll interval deterministically — it overrides the compiler-inferred value; **prefer this over relying on inference**. |
| `watchtell list` | Show every checker: id, request, interval, route, last state, last fired. |
| `watchtell test <id>` | Run one checker now (ignores schedule), print its result. Sends NO notification. |
| `watchtell rm <id>` | Delete a checker + its trust record + state. |
| `watchtell daemon status` | running / not running / stale-pid. |
| `watchtell daemon start --detach` | Start the poller in the background for this login. |
| `watchtell daemon install` | Register a launchd LaunchAgent so the poller auto-starts at every login (survives reboot). `uninstall` removes it. |

## 1. Before you touch `watchtell` — health checks

Run these first and act on the result (do not assume anything is installed or running):

1. **watchtell installed?** `command -v watchtell`. If missing, tell the user it is not installed and give
   the install steps (from source until the npm release): `git clone https://github.com/pchuri/watchtell
   && cd watchtell && npm install && npm link`. Do not proceed until it's on PATH.
2. **A compile CLI available?** `command -v claude || command -v codex`. `watchtell add` shells out to one
   of these to compile the request (no API key — it uses the CLI you're already logged into). If neither
   is on PATH, tell the user; `add` cannot compile without one.
3. **macOS?** watchtell is macOS-only (notifications use Notification Center; auto-start uses launchd). On
   any other OS, say so and stop.
4. **Daemon running?** `watchtell daemon status`. See §5 — a registered alarm does nothing until a daemon
   is polling.

## 2. Consent — REQUIRED before every `add`

`add` spawns your local LLM CLI to generate a bash script, and the daemon then executes that script on
your machine every interval, indefinitely, until you remove it. So before registering, confirm with the
user and get an explicit yes:

- the **exact request text** you are about to compile (paste it),
- the **poll interval** ("every 5 minutes"),
- **what it will fetch** — the URL/endpoint — and **with what auth** (a public endpoint, or a logged-in
  session via an auth wrapper like `auth-curl`, which uses your existing browser cookies),
- that this **spawns claude/codex now** and **runs generated bash persistently** afterward.

One consent per alarm. Never register an alarm the user did not ask for. Never batch-register.

## 3. Write a GOOD alarm request (compile quality lives or dies here)

Compilation is a single LLM pass and is only as good as the request. The most common failure is the
compiler **guessing the wrong field/param**; without `--interval`, it can also guess the wrong interval.
Make the request precise and self-contained. Rules:

1. **One concern per alarm.** One checker = one transition. Split "CI red OR new release" into two `add`s.
2. **Give the exact, full URL/endpoint**, including query params. Paste it literally.
3. **Name the exact field/param and where it lives.** e.g. "the top-level `version` field of the JSON",
   or "links look like `...&numberKey=NNNNN` and `numberKey` is each item's unique id — extract every
   `numberKey=` number". Do not leave the key to inference; that is the #1 mis-compile.
4. **State the value shape and the comparison + direction.** "a version string; alarm when it differs from
   the previous value"; "a number; alarm when it goes **above** 1400". Give the threshold explicitly, and
   say whether the recovery transition (back below) should alarm too.
5. **Define the transition precisely** — what is "before" vs "after": change / new-item-appears /
   threshold-cross / present→absent.
6. **Specify auth explicitly.** If the target needs a login, say "use `auth-curl`" (or whichever
   cookie-carrying wrapper the user has) **and name the sentinel that means logged-out** so it can alarm
   "re-login needed" instead of silently breaking (e.g. the page contains "권한이 없습니다"). If it's public,
   say "public API, no auth" so the compiler doesn't add auth it doesn't need.
7. **Put the URL you want to OPEN into the alarm message.** If `terminal-notifier` is installed the first
   URL in the message becomes click-to-open, so add: "include <URL> in the alert so I can click through".
8. **Set the interval explicitly with `--interval`** (`--interval 5m`, `600`, `90s`, `1h`) — it overrides
   the compiler and is deterministic, killing the mis-inference error class. Prefer it over stating the
   interval only in words. If you do leave it to inference, state it in plain words ("every 5 minutes")
   and VERIFY it landed (see §4). The 60s floor still applies to the flag value.
9. **Don't ask for timeouts/retries/"keep trying for N seconds".** The runtime enforces a hard 30s
   timeout and the checker must be a single quick probe. Requesting tool flags reintroduces a bug the
   project already fixed.
10. **Keep the probe cheap and idempotent:** one fetch + one parse. No multi-page crawls, no per-poll
    logins, nothing that can't finish in ~30s.
11. **Write the request in the language you want the alarm in** — the compiler mirrors the request's
    language.

**Good vs weak request (same target):**

| Weak (will mis-compile) | Good (compiles cleanly) |
|---|---|
| "tell me when npm has a new version of foo" | "Watch `https://registry.npmjs.org/foo/latest`; it's a public API, no auth. Alarm when the top-level `version` field changes from its previous value. Include `https://www.npmjs.com/package/foo` in the message so I can click through. Every 5 minutes." |
| "alert me when the board gets a new post" | "Use `auth-curl` to fetch `https://site/board?menuKey=7`. Item links look like `view?menuKey=7&numberKey=NNNNN`; `numberKey` is each post's unique id. Extract all `numberKey=` numbers; alarm when a numberKey appears that wasn't there before, and include the newest post's URL. If the page contains '권한이 없습니다', alarm 're-login needed'. Every 10 minutes." |

## 4. Register + verify (do all of this before saying "it's live")

1. Get consent (§2) and draft a good request (§3).
2. `watchtell add "<request>" --yes --interval <duration>` — pass `--interval` (e.g. `--interval 10m`) so
   the poll interval is deterministic instead of inferred. The command prints the **full generated bash**
   and a `meta: interval=<N>s route=<r>` line, keeps it, and runs one immediate silent test.
3. **Review the printed script** (it's in the command's stdout — read it there; do NOT open or edit the
   files under `~/.watchtell/checkers/`). Confirm:
   - it fetches the **right URL**, with the auth you intended;
   - it extracts the **right field/param** (not a guessed or empty one);
   - it has first-run-silent + a state sidecar (`$WATCHTELL_STATE`), prints exactly one line on
     transition, and stays silent / keeps state on a probe error;
   - it did NOT add `--max-time` / `--retry` / other tool timeout flags, and references only tools that
     are installed.
   - the `meta` **interval matches** the requested duration after applying the 60s floor (deterministic
     when you passed `--interval`; still worth a glance).
4. `watchtell test <id>` — expect `silent (no transition)` (first run recorded a baseline) or a sane
   `TRANSITION: …`. Run it again to confirm a steady target stays silent.
5. **Decide:**
   - **Good** → tell the user it's registered as `<id>`, on the confirmed interval, and confirm the daemon
     is polling (§5). Report what the alarm message will look like.
   - **Bad** → `watchtell rm <id>`, then re-`add` with a **sharper hint** targeting the exact defect
     (e.g. "the version is at JSON path `.version`, not `.dist-tags.latest`"; "extract `numberKey`, not
     `idx`") — and pass `--interval` to fix any interval mistake outright rather than re-hinting it.
     Re-compiling is non-deterministic, so always re-review.

**Mis-compile signals → rm + re-add:** wrong/placeholder URL; empty or wrong field extraction; alarms on
`add`'s immediate baseline run (the first observation); no state sidecar (would re-alarm every poll);
`checker error:` or `timed out` from `test`; references a tool that isn't installed; interval wrong in
`meta`. A later explicit `watchtell test` may legitimately report a transition if the target changed.

## 5. Keep the daemon alive (the hand-off only works if it polls)

`watchtell daemon status`:
- **not running** → the value proposition is dead. Recommend **`watchtell daemon install`** (launchd
  LaunchAgent: auto-starts at every login and restarts on crash — best for a hand-off that must outlive
  this session and survive reboots). `watchtell daemon start --detach` is the lighter option that lasts
  only until logout. Explain the trade-off and let the user pick; prefer `install` for anything meant to
  persist.
- **stale pid** → `watchtell daemon start --detach` (or `install`) clears it.
- Note the limits: a user LaunchAgent does **not** run while logged out; notifications need a GUI login
  session. This is a local, single-user tool.

## 6. What watchtell is NOT for (don't stretch it)

Say so plainly and suggest the right tool instead:
- **Not a general web monitor / scraping SaaS.** It's for arbitrary *developer-owned* checks, not hosted
  page-diffing.
- **Not for sub-minute frequencies.** Checks are quick probes on a poll loop; recommend ≥5 min, never
  below ~1 min. Don't hammer a target.
- **Not for team / headless / remote / CI use.** Notifications are macOS-local to one logged-in user.
  There is no Slack/LINE/webhook routing (a `route=slack` compiles but is relayed to local notify).
- **Not real-time or guaranteed delivery.** Polling + transition-dedupe; a rapid flap between two polls
  can be missed.
- **Not for secrets.** The request text is stored verbatim in `meta.json` and checkers are plain files —
  never put tokens/credentials in the request.

## 7. Never do

- Never register an alarm the user didn't explicitly ask for, or auto-register because it "seems useful".
- Never edit, patch, or overwrite files under `~/.watchtell/checkers/` — any byte change breaks the trust
  hash and disables the checker. To change a checker: `watchtell rm <id>` then re-`add`.
- Never hand-write or inject a checker script bypassing `add` — the daemon refuses any script that isn't
  hash-bound through Keep.
- Never use `--yes` to register a request the user hasn't seen and approved.
- Never stop/uninstall the daemon or remove other checkers for unrelated reasons.
