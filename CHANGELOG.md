# 1.0.0 (2026-07-27)


### Bug Fixes

* **daemon:** prevent removed checkers from being resurrected ([#11](https://github.com/pchuri/watchtell/issues/11)) ([6d84435](https://github.com/pchuri/watchtell/commit/6d84435185374a4399529e84f3c1b4e4d10c66c3))
* **daemon:** retry undelivered notifications ([#10](https://github.com/pchuri/watchtell/issues/10)) ([d9117ee](https://github.com/pchuri/watchtell/commit/d9117eec4a1cb93de03a0980366e4497e541daae))
* make compilation resilient to slow agent responses ([#2](https://github.com/pchuri/watchtell/issues/2)) ([d52df30](https://github.com/pchuri/watchtell/commit/d52df3042c6b004063942e5fcdaa10a7d7d9f728))
* prevent unsupported timeout flags in generated checkers ([#5](https://github.com/pchuri/watchtell/issues/5)) ([d32b8d4](https://github.com/pchuri/watchtell/commit/d32b8d462c18be17ced5e343a767b466d322fdd8))


### Features

* add coding-agent skill management commands ([#8](https://github.com/pchuri/watchtell/issues/8)) ([34ab840](https://github.com/pchuri/watchtell/commit/34ab840b982af177f2861956644b6d4d88f00151))
* add launchd-managed daemon auto-start ([#4](https://github.com/pchuri/watchtell/issues/4)) ([837d1e9](https://github.com/pchuri/watchtell/commit/837d1e948d7a1b4af9515ae86b473849c70ac3c6))
* add natural-language alarm CLI and daemon ([#1](https://github.com/pchuri/watchtell/issues/1)) ([afae6ee](https://github.com/pchuri/watchtell/commit/afae6ee690ae627dad3977f2ef01fe7da098118d))
* add watchtell coding-agent skill ([#7](https://github.com/pchuri/watchtell/issues/7)) ([dbe11b3](https://github.com/pchuri/watchtell/commit/dbe11b3a06a33b458fff8b18f8c1acb8da7d6b2a)), closes [hi#quality](https://github.com/hi/issues/quality)
* automate npm publishing with semantic-release ([#12](https://github.com/pchuri/watchtell/issues/12)) ([d9a989c](https://github.com/pchuri/watchtell/commit/d9a989c1a99359a1f6a521a9cc3a233a7e38e1e7))
* **cli:** add explicit poll interval flag ([#9](https://github.com/pchuri/watchtell/issues/9)) ([feebacd](https://github.com/pchuri/watchtell/commit/feebacd284824ba9e2305cdedbbdf5e5183718f8))
* enforce a 60-second poll interval floor ([#6](https://github.com/pchuri/watchtell/issues/6)) ([50e78a6](https://github.com/pchuri/watchtell/commit/50e78a606811aef4a754bc005986e1a422b49963))
* open alarm URLs from macOS notifications ([#3](https://github.com/pchuri/watchtell/issues/3)) ([d705c90](https://github.com/pchuri/watchtell/commit/d705c90f751f7fb4a94ef2ef6e698d4009c3dee0))
