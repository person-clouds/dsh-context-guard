---
audience: shared
status: current
---

[中文](README.md) | [English](README.en.md)

# dsh-context-guard

A context-budget and risk safety net for DSH: long output stays out of the context, risky commands ask first.

In long sessions, `ls -la`, whole-file `cat`, `journalctl` and repeated `curl` polls are billed again and again, and DSH's persistent-bash truncates at 16,000 characters by default, so even archived output can be incomplete. This plugin keeps those outputs out of the context while preserving the full evidence on disk.

## The four things that matter most

**1. Risk confirmation (most important)**
`rm -rf`, `git reset --hard`, `curl | bash`, non-allowlisted hosts, shutdown/service stop, database drops, privilege escalation — all ask before running. "Allow once" covers that one command; "always allow" stores a narrow rule so similar commands stop asking. This is a safety net after DSH's own permission policy, not a replacement for permissions or sandboxing. Rules are regex heuristics and may over- or under-report; high-risk production work still deserves a human look. Link checks only look at fetch commands at the start of a shell segment (`curl`/`wget`/`xdg-open` and similar) after stripping wrappers such as `sudo`/`env`/`timeout`/`xargs`/`nice`/`stdbuf`/`busybox`/`watch`/`sh -c`, subshell syntax, `$(…)`/backtick command substitution, and indirection such as `eval`/`find -exec`/`env -S`/`chroot`/`ssh`; document text, non-executed heredoc bodies, and quoted patterns are not treated as visited links, while a heredoc fed to a shell (`bash <<EOF`, `… <<EOF | bash`) is still scanned as commands, and an unquoted heredoc body is scanned only for the command substitutions bash would actually run (`$(…)`/backticks) with its text still treated as documentation. Indirection is first turned back into a real command: `ssh -p 22 host …` skips value-taking options before the host, and `find … -exec sh -c '…'` / `eval '…'` get their quoting restored.

**2. Deduplication**
Same session + same tool + same args, unchanged result within 10 minutes: only a pointer to the previous call comes back. Changed result: only a line-level diff. Commands always really run; the cache only saves context.

**3. Per-turn call gate 80/160**
The 80th bash call in a turn returns one approval reminder (yellow dot in the session list). The 160th is denied, and the Web client fills "继续" for you — press Enter to continue. This stops runaway loops, not normal work.

**4. Command-shape enforcement**
Whole-file `cat`, unscoped recursive searches under the home directory, and bare `curl .../api/...` are denied by default with bounded alternatives (`ops_inspect_local_file`/`ops_grep` under dsh-ops, `read`/`grep` otherwise, plus `jq` and `sed -n`). For complex shell workflows, set `commandLintMode: ask`.

## All features

1. **Bounded summaries** — over-budget output is fully written to disk; the context keeps head/tail, command type and path.
2. **Deduplication** — identical results return a pointer; changes return a line-level diff.
3. **Per-turn call gate** — `ask` at call 80, `deny` at call 160, with Web auto-fill of "继续".
4. **Per-turn output gate** — after 40 KB enters the context in one turn, later results over 800 characters become a summary plus path.
5. **Command-shape enforcement** — `deny` by default, switchable to `ask`; system-prompt guidance is injected too.
6. **Risk confirmation** — risky commands ask first; "allow once" / "always allow" narrow rules with a recorded reason.
7. **Read-only diagnostics** — `scripts/inspect.sh` replaces ad-hoc commands with fixed, bounded patterns.
8. **Compaction archive + metrics + cleanup** — writes `STATUS.md` around compaction, records savings, prunes by retention and quota.
9. **Documentation commit guard** — runs `scripts/check.sh` before `git commit`; bad docs are denied.
10. **Compaction threshold self-check** — `scripts/apply-compaction.sh` checks and replays the four built-in presets.

## Install

From a GitHub Release (recommended, no build step):

```bash
dsh plugin --profile web add https://github.com/person-clouds/dsh-context-guard/releases/latest/download/dsh-context-guard.tgz
```

Or from npm / a local checkout:

```bash
dsh plugin --profile web add @fenghoer/dsh-context-guard
# or
dsh plugin --profile web add link:/home/zh/www/dsh-context-guard
```

Then run the host migration script (it checks the package is installed and backs up the profile first):

```bash
dsh-context-guard/scripts/apply-profile.sh
```

The script does four things:

- replaces the old `compaction-archive` insert with `context-guard` and fixes the scoped package name; if a profile lacks the package it prints the `dsh plugin --profile <p> add link:...` command and exits non-zero;
- removes the top-level `persistent-bash` block that causes `patch: entry "persistent-bash" not found` and instead overlays the complete `minimal` preset `config.plugins`, setting `maxOutputChars` to `65536` (rerun after upgrading DSH);
- aligns the top-level official `tool-result-pruner` to `6000/3000/1500`;
- if `node_modules/dsh-superagent` is a link to a missing path, prints the fix command.

Verify:

```bash
dsh --profile web --dump-config | grep -E "context-guard|maxOutputChars|tool-result-pruner"
```

## Local setup on this machine

Since 2026-11-22 this host runs "full access, ask when needed", which relies on two pieces of configuration; both need a `dsh-web` restart:

- **Permission preset** — in `~/.dsh/profiles/web/cordis.patch.yml`, the `permission` plugin's `full-access-ask` preset (`sandbox: danger-full-access` + `approval: ask`), selected as the default via `defaultPreset: full-access-ask`. The stock `danger-full-access` preset uses `approval: never`, which auto-rejects risk confirmations within milliseconds and reports `the user rejected tool "bash"`.
- **Risk allowlist** — `kind: "host"` rules in `~/.dsh/context-guard/risk-allow.json` (the file approval cards write to on "always allow"), layered on the built-in defaults in `config/risk-allow-default.json`, e.g. `192.168.31.244`, `100.84.98.28`, `zh-gem-r7.tailb6e152.ts.net`. Host rules only strip `unknown-link` / `insecure-http` when every fetch that will actually run can be proven to hit an allowlisted host; a URL whose host cannot be derived (placeholder, pattern string, runtime expansion via `$`/`{`/`` ` ``, invalid port), a command with no parseable host, or any fetch segment whose target is not visible as a literal URL (`curl "$ENDPOINT"`, `… | xargs curl`), or a segment that carries a literal URL plus a dynamic argument (`curl https://ok.example/ "$ENDPOINT"`, though `$VAR` inside value flags such as `-H`/`-d`/`-o` does not count) keeps the original verdict instead of being silently allowed. Approval uses the same real-fetch-segment extraction as analysis, so `grep` patterns and document-style heredoc bodies neither pollute the host set nor get persisted as host rules. The approval card lists at most 3 not-yet-allowed links (with the total count when there are more), and "always allow" only persists host rules for exactly those listed links — what the card shows is what gets allowlisted. `RiskRuleStore` reads the file only at process start, so manual edits need a restart. A `curl`/`wget` whose target never appears as a literal URL (`curl "$ENDPOINT"`, `wget -i urls.txt`) is raised as `unverifiable-fetch`: with no visible host, no host rule is written and "always allow" only records that single command.

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

- **Call gate**: the 80th bash call in a turn returns one `ask`; the 160th and later are denied. Denies carry the marker `context-guard:hard-limit-draft`; the Web client fills an **empty** composer with `继续` (never sends automatically — press Enter; at most 3 fills per session and 1 per turn, also restored when the event is within the last 30 minutes; Desktop/TUI silently falls back). `turn/start` resets counters; if that event is missing the plugin falls back to per-session counting and logs a warning. Messages show both the turn's bash-call count and the current `session step`, which are different counters.
- **Output gate**: after actual emitted context exceeds `maxTurnOutputChars=40000` in a turn, later results over `exhaustedOutputChars=800` are fully archived while the context receives at most 800 characters plus the path.
- **Command enforcement**: `commandLintMode: deny` by default. Whole-file `cat` points to the active file-read tool (`ops_inspect_local_file({ path, offset, limit })` or `read`) or `sed -n '1,120p'`; unscoped recursive search points to `ops_grep`/`grep` or `--glob '!**/node_modules/**'`; bare `curl .../api/...` points to `| jq '{field1,field2}'` or `-o /tmp/out.json` followed by a query.
- DSH does not allow `tools/pre-execute` to rewrite tool arguments, so the plugin denies the current call and puts the replacement in the model-visible `reason`; the model retries with a bounded call.
- Complex shell workflows can set `commandLintMode: ask` to downgrade to confirmation; `commandGuidanceEnabled: true` also registers system-prompt guidance for the active file tools and `jq`.
- In `ask` mode a command-lint match and a risk match merge into one `ask`; a lint `deny` or an existing `deny`/`cancel` wins.

## Risky-command warnings

`tools/pre-execute` runs after DSH's own permission policy as a final safety net. On a match it returns `ask`, so DSH's approval UI asks the user; the command does not run without confirmation. It does not rewrite commands, sandbox execution, or replace DSH permissions. It checks `bash` / `persistent-bash` / `terminal-bash` and `web_fetch` by default.

| Category | Examples |
|---|---|
| File/repo deletion | `rm -rf`, `rm -rf .git`, `find ... -delete`, `shred`, `truncate -s 0` |
| Destructive git | `git reset --hard`, `git clean -fd`, `git push --force`, `git branch -D` |
| Download-and-execute | `curl ... \| bash`, `bash <(curl ...)` |
| Unknown hosts | `curl` / `wget` / `xdg-open` to non-allowlisted hosts, or plain HTTP |
| System damage | shutdown, stopping services, firewall flush, killing processes, deleting containers/volumes/K8s resources |
| Databases | `DROP DATABASE/TABLE`, `TRUNCATE TABLE`, `DELETE FROM` without `WHERE` |
| Privilege/history | `sudo`, `doas`, `su -`, `history -c` |

Exemption boundaries:

- `rm` skips `destructive-rm` only when every target is under `/tmp`, `/var/tmp`, `$TMPDIR`/`${TMPDIR}`, `~/opt` (including `/home/<user>/opt`), or entirely inside test directories (`test`, `tests`, `__tests__`, `test-*`, `*-test`, `*.test`, `*.spec`). Only explicitly listed files/directories are exempt; the roots themselves and wildcards (`/tmp/*`, `~/opt/*`) are still blocked, as are targets containing `..`/`*`/`?`/`[`, `sudo`, `xargs`, command substitution or backticks.
- `sudo -n true`, `sudo -n -v`, and `sudo -n` with read-only inspection commands (`ls`, `stat`, `cat`, `grep`, `systemctl status`, etc.) do not trigger `privilege-escalation`; self-cleaning write probes (`touch <probe> && rm <same file>`, `f=$(mktemp /tmp/...) && rm -f "$f"`) do not trigger `destructive-rm`.
- These roots, test directories, `~/opt`, build-artifact directories, write probes and the `sudo`/`systemctl` read-only lists all come from [`config/risk-allow-default.json`](config/risk-allow-default.json).

The default host allowlist is also from that file: 28 hosts grouped as `local`, `codeHosting`, `api`, `docs`, `techMedia`. Groups only affect docs and review, not runtime matching. An explicit `riskAllowHosts` overrides the built-ins; hosts saved by "always allow" are unioned with them. Personal/internal domains (such as Tailscale hosts) stay out of the built-ins. If the config is missing or invalid, the plugin falls back to minimal safe defaults (only `localhost`, `127.0.0.1`, `[::1]`) and warns.

"Always allow" resolves a short-lived token from the approval reason back to the original command, re-parses it, and stores a narrow rule in `${DSH_HOME:-~/.dsh}/context-guard/risk-allow.json`:

- It first asks for a reason (required, up to 200 characters), stored as the rule label `reason`, shown only for review and never used for matching. The reason is plaintext — do not enter secrets.
- Build-artifact cleanup becomes a "project prefix + artifact directory" class rule: after confirming `rm -rf ./node_modules`, the same project may run `rm -rf ./dist` or `rm -rf packages/a/build`; `./src`, `..`, `sudo`/`xargs` and command substitution still ask; trailing wildcards inside an artifact directory and `find ... -delete` follow the same class rule.
- When the only risk is an unknown link, only that host is stored; if no safe class can be proven, the rule falls back to the exact normalized command hash. Command-shape lint and DSH permissions still apply.
- Set `riskAutoAllowEnabled: false` to disable the button and auto-allow, `riskRuleFile` to move the file, or delete the JSON to revoke all rules.
- Pending entries live in memory for 10 minutes and are also written briefly to `risk-pending.json` (0600, expired entries cleaned) to survive a plugin reload; when the token is gone the plugin falls back to the approval `callId`.
- If saving fails, the page shows the error code and HTTP status (e.g. `approval-rule-expired (HTTP 410)`) in a toast and the console; a save over 2 seconds reports progress first, and 15 seconds counts as a timeout. A failed save leaves "allow once" available.

## Deduplication and diffs

- Cache key: `session + tool + args`; TTL 10 minutes, refreshed on use.
- Only non-error results of at least 800 characters are deduplicated; replacing `ok` with a pointer would be more expensive.
- **The command always really runs** — execution is never cached, because persistent-shell cwd/env state is unreliable.
- Identical result: `[context-guard:dedup]` plus the previous call pointer.
- Changed result: `[context-guard:diff]` with only the changed block between common prefix/suffix.
- The cache is in-process memory and is lost on restart; this is an intentional safety choice.

## Documentation commit guard

`tools/pre-execute` recognizes `git commit` (including `git -C <dir> commit` and `cd <dir> && git commit`) and resolves the target repository. For a registered repository it runs the workspace `scripts/check.sh --repo <repo>` using the central `scripts/docs-policy.json`; a failure returns `deny` with the failing items. It never edits files automatically. Non-commit commands and unregistered repositories are not affected.

Config: `docGuardEnabled` (default `true`), `docGuardWorkspaceRoot` (default `/home/zh/www`), `docGuardTimeoutMs` (default `30000`). Restart the DSH profile after changing them.

## Data directories

```text
${DSH_HOME:-$HOME/.dsh}/tool-output/<session-id>/<timestamp>-<call-id>.log
${DSH_HOME:-$HOME/.dsh}/context-guard/metrics/<session-id>.jsonl
${DSH_HOME:-$HOME/.dsh}/context-guard/metrics/STATUS.md
${DSH_HOME:-$HOME/.dsh}/context-guard/archive/<session-id>/STATUS.md
```

Cleanup: retain 7 days; 50 MB / 300 files per session; 500 MB total; delete oldest files; keep the 3 most recent files for the current session. Directories are 0700 and files 0600.

## Metrics

JSONL fields: `session`, `call`, `tool`, `cmdType`, `originalChars`, `emittedChars`, `savedChars`, `dedup`, `diffSummary`, `isError`, `archived`.

Token savings are estimated as `chars/4`, and `STATUS.md` states this `estimateMethod` explicitly. Metrics are recorded only; no UI yet.

## inspect.sh

```bash
dsh-context-guard/scripts/inspect.sh overview
dsh-context-guard/scripts/inspect.sh service nginx
dsh-context-guard/scripts/inspect.sh app qbittorrent
dsh-context-guard/scripts/inspect.sh logs /var/log/syslog 80
dsh-context-guard/scripts/inspect.sh git /home/zh/www/personalCloud
dsh-context-guard/scripts/inspect.sh ports
dsh-context-guard/scripts/inspect.sh docker
dsh-context-guard/scripts/inspect.sh http http://127.0.0.1:3082/
dsh-context-guard/scripts/inspect.sh report
```

Principles: no sudo, no service start/stop, and every section has line/byte limits. If `linuxops` exists, only read-only subcommands (`sysinfo`, `network ports`, `service status/logs`) are used; otherwise it falls back to `systemctl` / `journalctl` / `ss`. Machine-private extensions belong in `~/.dsh/context-guard/inspect.local.sh`.

## linuxops (optional)

`inspect.sh` does not require `linuxops`; without it, the script falls back to system tools. To unify output format, choose one of three options:

| Option | Who it is for | Command |
|---|---|---|
| A. Do not install | Only system tools needed | Nothing to do; automatic fallback |
| B. Plugin read-only shim | No upstream binary, unified output wanted | `dsh-context-guard/scripts/install-linuxops.sh` |
| C. Install your own/upstream binary | Already built/downloaded a trusted `linuxops` | `dsh-context-guard/scripts/install-linuxops.sh --binary /path/to/linuxops` |

Option B installs a bundled read-only shim, **not the upstream linuxops project**. It implements only the four interfaces used by `inspect.sh`:

```text
linuxops sysinfo
linuxops service status --name <unit>
linuxops service logs --name <unit> --lines <n>
linuxops network ports
```

```bash
# B: install to ~/.local/bin/linuxops (no sudo)
dsh-context-guard/scripts/install-linuxops.sh
# C: hand a built binary to the installer; the plugin never copies or overwrites upstream source
dsh-context-guard/scripts/install-linuxops.sh --binary ./linuxops --force

# Pass LINUXOPS_BIN when it is not on PATH; force-reinstall / uninstall
LINUXOPS_BIN="$HOME/.local/bin/linuxops" dsh-context-guard/scripts/inspect.sh overview
dsh-context-guard/scripts/install-linuxops.sh --force
dsh-context-guard/scripts/install-linuxops.sh --uninstall
```

Notes: only the read-only subcommands above are called; neither the shim nor the installer uses sudo, writes to the system, or starts/stops services; the shim is not a security boundary.

## Compaction threshold self-check

`~/.dsh/cordis.patch.yml` overrides `compaction-basic` thresholds (`0.08/0.02/65536`) for the four built-in presets. Those overrides are full copies of the installed presets, so they go stale after a DSH upgrade. Check and replay them with:

```bash
bash dsh-context-guard/scripts/apply-compaction.sh check     # read-only, exits 0 when all PASS
bash dsh-context-guard/scripts/apply-compaction.sh dry-run   # show which presets would change
bash dsh-context-guard/scripts/apply-compaction.sh apply     # back up, rewrite in place, print rollback
```

`apply` is run by the user in their own terminal (the AI sandbox is read-only for `~/.dsh`); the plugin never calls it. See section 5.5 of [`docs/context-compaction.md`](docs/context-compaction.md) for details.

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
        maxCallsPerTurn: 80              # approval reminder at call 80
        hardMaxCallsPerTurn: 160         # hard deny + auto-fill "continue" at call 160
        maxTurnOutputChars: 40000
        exhaustedOutputChars: 800
        commandLintEnabled: true
        commandLintMode: deny      # deny (default, hard block) | ask (confirm complex workflows)
        commandGuidanceEnabled: true
        dedupeMinChars: 800
        dedupTtlMs: 600000
        riskCheckEnabled: true
        riskAutoAllowEnabled: true
        # riskRuleFile: /home/zh/.dsh/context-guard/risk-allow.json
        docGuardEnabled: true
        docGuardWorkspaceRoot: /home/zh/www
        docGuardTimeoutMs: 30000
        # riskToolNames: [bash, persistent-bash, terminal-bash, web_fetch]
        # riskAllowHosts: [localhost, 127.0.0.1, github.com]
        retentionDays: 7
        maxSessionBytes: 52428800
        maxTotalBytes: 524288000
        maxFilesPerSession: 300
```

## Tests

```bash
cd dsh-context-guard && npm test
```

Coverage: compaction archive, command classification/budgets, bounded rendering, large-output archival, deduplication, line-level diffs, per-turn call and output gates, hard-limit auto-fill and its 3-use budget, command-shape deny/ask with merged `ask`, metrics, expiry cleanup, risky-command detection and narrow allow rules, documentation commit guard, `inspect.sh` syntax/help, and the Web client script.

## Boundaries

- Handles `bash` / `persistent-bash` / `terminal-bash` by default; other tools can be added via `toolNames`.
- Deduplication is not persisted across processes.
- Risk checks are heuristic safety nets, not a sandbox; `ask` is decided by DSH's approval service, and when no approval service exists DSH rules deny it.
- No write-operation diagnostics (kill, restart, cron, backup restore, etc.).
- linuxops is not installed automatically; use `scripts/install-linuxops.sh` for the optional read-only shim, or point `LINUXOPS_BIN` at your own binary.
