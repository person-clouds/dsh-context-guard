[中文](README.md) | [English](README.en.md)

# dsh-context-guard

A DSH Host-only plugin that keeps long tool output out of the context while preserving the full evidence.

Problem: in long sessions, `bash` output (`ls -la`, whole-file `cat`, `journalctl`, repeated `curl` polls) is billed again and again. DSH's persistent-bash also truncates at 16,000 characters by default, so even archived output is incomplete.

The plugin provides seven safeguards:

1. **Bounded summaries** — when output exceeds its budget, the full text is written to disk and the context receives only head/tail, command type and the archive path.
2. **Deduplication** — identical results for the same session + tool + args within 10 minutes return a pointer to the previous call; changed results return a line-level diff.
3. **Per-turn call gate** — the 21st bash call in a turn returns one `ask`; the 40th and later calls are denied.
4. **Per-turn output gate** — after more than 40 KB has entered the context in one turn, later results over 800 characters are reduced to a summary plus archive path.
5. **Command-shape enforcement** — whole-file `cat`, unscoped recursive searches under the home directory, and bare `curl` API calls are denied by default with bounded alternatives (`read`/`grep`/`jq`); `ask` mode is configurable; system-prompt guidance is injected too.
6. **Read-only diagnostics** — `scripts/inspect.sh` replaces ad-hoc commands with fixed, bounded patterns.
7. **Risk confirmation + compaction archive + metrics + cleanup** — confirms risky commands, writes `STATUS.md` around compaction, records savings, and prunes by retention period and quota.

## Install

From a GitHub Release (recommended, no build step):

```bash
dsh plugin --profile web add https://github.com/person-clouds/dsh-context-guard/releases/latest/download/dsh-context-guard.tgz
```

Or from npm / a local checkout:

```bash
dsh plugin --profile web add @fenghoer/dsh-context-guard
# or
dsh plugin --profile web add link:/home/zh/www/personalCloud/task/dsh-context-guard
```

Then run the host migration script (it checks the package is installed and backs up the profile first):

```bash
task/dsh-context-guard/scripts/apply-profile.sh
```

The script:

- replaces the old `compaction-archive` insert with `context-guard` and fixes the scoped package name `@fenghoer/dsh-context-guard`; if `node_modules/@fenghoer/dsh-context-guard` is missing in a profile, it prints the `dsh plugin --profile <p> add link:...` command to run and exits non-zero;
- removes the top-level `persistent-bash` block that causes `patch: entry "persistent-bash" not found`, and instead overlays the complete `minimal` preset `config.plugins`, setting its `persistent-bash` `maxOutputChars` to `65536`; rerun after upgrading DSH;
- aligns the top-level official `tool-result-pruner` to `6000/3000/1500`;
- if `node_modules/dsh-superagent` is a link to a missing path, prints the fix command `dsh plugin --profile <p> add link:/home/zh/www/dsh-superagent`.

Verify:

```bash
dsh --profile web --dump-config | grep -E "context-guard|maxOutputChars|tool-result-pruner"
```

## Output budgets

Defaults: `thresholdChars=2000`, `headChars=1200`, `tailChars=800`, hard cap 6000.

| Command class | Examples | Budget |
|---|---|---:|
| Default | ordinary bash | 2000 |
| Quick status | `ps`, `df`, `free`, `ss`, `systemctl status` | 1500 |
| Bounded logs | `journalctl --since`, `tail`, `docker logs --tail` | 2500 |
| Bounded source | `sed -n`, `rg`, `grep`, `git show` | 3000 |
| Diff | `git diff` | 3000 |
| Build/test | `npm test`, `go test`, `pytest` | 3000 |
| Errors | non-zero exit | at least 2500 |
| Explicit | first line `# dsh-budget=8000` | up to 6000 |

Unbounded commands (`cat`, `journalctl` without `--since`/`-n`, `find /`, `du /`) are capped at 1500 with a hint to use a bounded command. If writing to disk fails, the original result is returned rather than losing evidence.

## Per-turn gates and command hints

- Call gate: the 21st bash call in a turn returns one `ask` (not repeated in that turn); the 40th and later calls return `deny`. `turn/start` resets counters; if that event is missing, the plugin falls back to per-session counting and logs a warning.
- Output gate: after actual emitted context exceeds `maxTurnOutputChars=40000` in a turn, later results over `exhaustedOutputChars=800` are fully archived while the context receives at most 800 characters plus the path.
- Command enforcement: `commandLintMode: deny` by default. Whole-file `cat` points to the `read` tool (or `sed -n '1,120p'`); unscoped recursive search points to `grep`/`glob` or `--glob '!**/node_modules/**'`; bare `curl .../api/...` points to `| jq '{field1,field2}'` or `-o /tmp/out.json` followed by a query.
- DSH does not allow `tools/pre-execute` to rewrite tool arguments, so the plugin cannot silently turn `cat` into `read`; it denies the current call and puts the replacement in the model-visible `reason`, letting the model retry with a bounded call.
- Complex shell workflows can set `commandLintMode: ask` to downgrade to confirmation; `commandGuidanceEnabled: true` also registers system-prompt guidance for `read`/`grep`/`jq`.
- In `ask` mode a command-lint match and a risk match are merged into one `ask`; a lint `deny` or an existing `deny`/`cancel` wins.

## Risky-command warnings

`tools/pre-execute` runs after DSH's own permission policy as a final safety net. On a match it returns `ask`, so DSH's approval UI asks the user; the command does not run without confirmation. It does not rewrite commands, sandbox execution, or replace DSH permissions. It checks `bash` / `persistent-bash` / `terminal-bash` and `web_fetch` by default.

Default coverage:

| Category | Examples |
|---|---|
| File/repo deletion | `rm -rf`, `rm -rf .git`, `find ... -delete`, `shred`, `truncate -s 0` |
| Destructive git | `git reset --hard`, `git clean -fd`, `git push --force`, `git branch -D` |
| Download-and-execute | `curl ... \| bash`, `bash <(curl ...)` |
| Unknown hosts | `curl` / `wget` / `xdg-open` to non-allowlisted hosts, or plain HTTP |
| System damage | shutdown, stopping services, firewall flush, killing processes, deleting containers/volumes/K8s resources |
| Databases | `DROP DATABASE/TABLE`, `TRUNCATE TABLE`, `DELETE FROM` without `WHERE` |
| Privilege/history | `sudo`, `doas`, `su -`, `history -c` |

Default host allowlist: `localhost`, `127.0.0.1`, `[::1]`, `github.com`, `gitee.com`, `raw.githubusercontent.com`; override with `riskAllowHosts`. Rules are regex heuristics and can both over- and under-report; high-risk production operations still need human review.

## Deduplication and diffs

- Cache key: `session + tool + args`.
- TTL: 10 minutes, refreshed on use.
- Only non-error results of at least 800 characters are deduplicated; replacing `ok` with a pointer would be more expensive.
- **The command always really runs** — execution is never cached, because persistent-shell cwd/env state is unreliable.
- Identical result: `[context-guard:dedup]` plus the previous call pointer.
- Changed result: `[context-guard:diff]` with only the changed block between common prefix/suffix.
- The cache is in-process memory and is lost on restart; this is an intentional safety choice.

## Data directories

```text
${DSH_HOME:-$HOME/.dsh}/tool-output/<session-id>/<timestamp>-<call-id>.log
${DSH_HOME:-$HOME/.dsh}/context-guard/metrics/<session-id>.jsonl
${DSH_HOME:-$HOME/.dsh}/context-guard/metrics/STATUS.md
${DSH_HOME:-$HOME/.dsh}/compaction-archive/<session-id>/STATUS.md
```

Cleanup: retain 7 days; 50 MB / 300 files per session; 500 MB total; delete oldest files; keep the 3 most recent files for the current session. Directories are 0700 and files 0600.

## Metrics

JSONL fields: `session`, `call`, `tool`, `cmdType`, `originalChars`, `emittedChars`, `savedChars`, `dedup`, `diffSummary`, `isError`, `archived`.

Token savings are estimated as `chars/4`, and `STATUS.md` states this `estimateMethod` explicitly. Metrics are recorded only; no UI yet.

## inspect.sh

```bash
task/dsh-context-guard/scripts/inspect.sh overview
task/dsh-context-guard/scripts/inspect.sh service nginx
task/dsh-context-guard/scripts/inspect.sh app qbittorrent
task/dsh-context-guard/scripts/inspect.sh logs /var/log/syslog 80
task/dsh-context-guard/scripts/inspect.sh git /home/zh/www/personalCloud
task/dsh-context-guard/scripts/inspect.sh ports
task/dsh-context-guard/scripts/inspect.sh docker
task/dsh-context-guard/scripts/inspect.sh http http://127.0.0.1:3082/
task/dsh-context-guard/scripts/inspect.sh report
```

Principles: no sudo, no service start/stop, and every section has line/byte limits. If `linuxops` exists, only read-only subcommands (`sysinfo`, `network ports`, `service status/logs`) are used; otherwise it falls back to `systemctl` / `journalctl` / `ss`.

Machine-private extensions belong in `~/.dsh/context-guard/inspect.local.sh` and are not shipped with the plugin.

## linuxops (optional)

`inspect.sh` does not require `linuxops`; without it, the script falls back to `systemctl`, `journalctl`, `ss`, `uname`, `free`, `df`. To unify output format, choose one of three options.

| Option | Who it is for | Command |
|---|---|---|
| A. Do not install | Only system tools needed | Nothing to do; `inspect.sh` falls back automatically |
| B. Plugin read-only compatibility shim | No upstream binary, but unified output wanted | `task/dsh-context-guard/scripts/install-linuxops.sh` |
| C. Install your own/upstream binary | Already built/downloaded a trusted `linuxops` | `task/dsh-context-guard/scripts/install-linuxops.sh --binary /path/to/linuxops` |

Option B installs a bundled read-only compatibility shim, **not the upstream linuxops project**. It implements only the four interfaces used by `inspect.sh`:

```text
linuxops sysinfo
linuxops service status --name <unit>
linuxops service logs --name <unit> --lines <n>
linuxops network ports
```

Install, verify and uninstall:

```bash
# Install to ~/.local/bin/linuxops (no sudo)
task/dsh-context-guard/scripts/install-linuxops.sh

# Add to PATH if needed, or pass LINUXOPS_BIN explicitly
export PATH="$HOME/.local/bin:$PATH"
linuxops --version
LINUXOPS_BIN="$HOME/.local/bin/linuxops" task/dsh-context-guard/scripts/inspect.sh overview

# Force reinstall / uninstall
task/dsh-context-guard/scripts/install-linuxops.sh --force
task/dsh-context-guard/scripts/install-linuxops.sh --uninstall
```

For option C, follow your chosen upstream README; then hand the binary to the installer. The plugin does not copy or overwrite upstream source:

```bash
# Example: build in a trusted source directory first, producing ./linuxops
task/dsh-context-guard/scripts/install-linuxops.sh --binary ./linuxops --force
LINUXOPS_BIN="$HOME/.local/bin/linuxops" task/dsh-context-guard/scripts/inspect.sh report
```

Notes:

- `inspect.sh` only calls the read-only subcommands above. If your upstream linuxops has a different interface, point `LINUXOPS_BIN` at a compatible binary or use option A.
- Neither the shim nor the installer uses sudo, writes to the system, or starts/stops services.
- The shim is not a security boundary; it only standardizes output formats, and permissions are still those of the running user.

## Configuration example

```yaml
- insert:
    - id: context-guard
      name: '@fenghoer/dsh-context-guard'
      config:
        thresholdChars: 2000
        headChars: 1200
        tailChars: 800
        hardMaxChars: 6000
        maxCallsPerTurn: 20
        hardMaxCallsPerTurn: 40
        maxTurnOutputChars: 40000
        exhaustedOutputChars: 800
        commandLintEnabled: true
        commandLintMode: deny      # deny (default, hard block) | ask (confirm complex workflows)
        commandGuidanceEnabled: true
        dedupeMinChars: 800
        dedupTtlMs: 600000
        riskCheckEnabled: true
        # riskToolNames: [bash, persistent-bash, terminal-bash, web_fetch]
        # riskAllowHosts: [localhost, 127.0.0.1, github.com]
        retentionDays: 7
        maxSessionBytes: 52428800
        maxTotalBytes: 524288000
        maxFilesPerSession: 300
```

## Tests

```bash
cd task/dsh-context-guard && npm test
```

Coverage: compaction archive, command classification/budgets, bounded rendering, large-output archival, deduplication, line-level diffs, per-turn call and output gates, command-shape deny/ask with merged `ask`, metrics, expiry cleanup, risky-command detection, plus `inspect.sh` syntax and help.

## Boundaries

- Handles `bash` / `persistent-bash` / `terminal-bash` by default; other tools can be added via `toolNames`.
- Deduplication is not persisted across processes.
- Risk checks are heuristic safety nets, not a sandbox; `ask` is decided by DSH's approval service, and when no approval service exists DSH rules deny it.
- No write-operation diagnostics (kill, restart, cron, backup restore, etc.).
- linuxops is not installed automatically; use `scripts/install-linuxops.sh` for the optional read-only shim, or point `LINUXOPS_BIN` at your own binary.
