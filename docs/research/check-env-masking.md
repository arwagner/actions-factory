# Masking `FACTORY_CHECK_ENV` values

Spike for #30. Spec context: §8 Checks, §9 Leakage.

## Answer

Yes, with one condition: every value has to go to `::add-mask::` escaped, as one command per value. Escaping means `%` → `%25`, CR → `%0D`, LF → `%0A`. A mask registered in a step:

- hides the value in the rest of that step and in every later step of the **same job**, wherever it came from: a fresh parse of the secret, `$GITHUB_ENV`, `${{ env.X }}` expressions, the step's `env:` header, stderr, `set -x` traces, or writes split into chunks before a newline.
- also hides the value's base64, URI-escaped and JSON-escaped forms.
- also covers `$GITHUB_STEP_SUMMARY`. The runner scrubs the summary file line by line with the job's masker at the end of the step (source below).
- does **not** carry into other jobs.

Two leaks remain, as #18 found: a value that check code splits across lines, and a reversed value.

Without the step, the secret masks only the whole blob **and each line of the blob**. A blob line is a dotenv source line such as `SIMPLE=tok1simple`, so a check that prints just `tok1simple` leaks it. That is why the step exists.

Multi-line values: since runner 2.286 (actions/runner#1521), an escaped multi-line `::add-mask::` also registers each line, trimmed, as its own mask. The flip side is that a 1-character line such as `Q` then masks every `Q` in the job log. The reference script therefore sends multi-line values line by line and skips lines shorter than 3 characters, with a warning.

Runner observed: 2.338.2 (`ubuntu-latest`), 2026-11-21.

## Setup

Throwaway private repo **arwagner/af-spike-mask** (kept). It has one repo secret, `FACTORY_CHECK_ENV`, holding fake values:

```dotenv
# fake test values only (actions-factory #30 spike)
SIMPLE=tok1simple
SPACES=tok2 has spaces
EQUALS=tok3=a=b
DQ="tok4 double quoted"
SQ='tok5 single quoted'
DOLLAR='tok6$HOME$$x'
PERCENT=tok7%41%25%0Az
MULTI="tok8line1
tok8line2
tok8line3"
TRAIL="tok9 trailing   "
SHORT=t0
JSONISH={"tokA":"v\"q"}
MULTI2="tokBa

   tokBindented   
Q"
ESCNL="tokCx\ntokCy"
EMPTY=
```

(Run 1 used the first 12 entries. Run 2 added `MULTI2`, `ESCNL` and `EMPTY`.)

`spike.yml` runs a matrix over four masking modes:

| mode | what step1 emits per value |
|---|---|
| `none` | nothing |
| `naive` | `::add-mask::<raw value>` |
| `escaped-whole` | `::add-mask::<escaped value>` |
| `robust` | escaped value plus each escaped line |

In each job:

1. **step1** prints every value, masks, writes the values to `$GITHUB_ENV` with heredoc syntax, then prints again.
2. **step2** has no secret and prints the values from `$GITHUB_ENV`.
3. **step3** passes them through `${{ env.X }}` into its `env:`.
4. **step4** (run 2) runs probes.

A separate `next-job` re-parses the secret without masking. Each value is printed raw, embedded in other text, base64, URI-escaped, JSON-escaped, and into `$GITHUB_STEP_SUMMARY`. `reference.yml` exercises the final script.

Runs:

- Run 1 (four modes, first 12 values): https://github.com/arwagner/af-spike-mask/actions/runs/44934709445
- Run 2 (plus `MULTI2`, `ESCNL`, `EMPTY`, probes): https://github.com/arwagner/af-spike-mask/actions/runs/44934935292
- Run 3, reference script: https://github.com/arwagner/af-spike-mask/actions/runs/44935068486

## Evidence

All of this is from `gh run view <id> --log`, with timestamps stripped.

**No add-mask (`none`).** The blob is masked line by line, and the individual values leak. `tok8line2` is masked only because it happens to be a whole line of the blob:

```
[step1-before-mask] whole blob follows:
***
***            (one *** per blob line)
[step1-after-mask] SIMPLE raw=<tok1simple>
[step1-after-mask] PERCENT raw=<tok7%41%25%0Az>
[step1-after-mask] MULTI raw=<tok8line1
***
tok8line3>
```

**Masks persist only within the job (`next-job`, run 1).** It is the same output as `none`: `[next-job] SIMPLE raw=<tok1simple>`.

**Naive (`naive`).** `%` gets un-escaped by the runner, and a raw newline ends the command:

```
[step1-after-mask] PERCENT raw=<***25%0A***>
[step1-after-mask] MULTI raw=<***
***
tok8line3>
```

`tok7%41%25%0Az` was registered as `tok7%41%` and `z` (after un-escaping, `%0A` became a newline). So the literal value is only partly masked, and `z` is now masked everywhere. While the commands themselves were being emitted, the lines after a raw newline went to the log as **plain output**:

```
***
tok8line3
   ***
Q
tokCy
##[warning]Can't add secret mask for empty string in ##[add-mask] command.
```

**Escaped whole value (`escaped-whole`).** Everything is masked, including each line of `MULTI` and `ESCNL`, and the multi-line value in the env header:

```
[step2-later] PERCENT raw=<***>
[step2-later] PERCENT b64=***
[step2-later] PERCENT uri=***
[step2-later] MULTI raw=<***
***
***>
env:
  MULTI: ***
  FROM_EXPR_MULTI: ***
```

The flip side, from step4 of run 2. The runner split `MULTI2` and masked its 1-character line `Q`:

```
  E***UALS: ***
  D***: ***
  S***: ***
***uick ***uestion: is every *** masked now? ***
```

**Probes (`robust`, run 2 step4):**

```
trimmed2 TRAIL=<***>          # trimmed form also masked (runner adds trimmed lines)
indented line trimmed=<***>
stderr SIMPLE=<***>
chunked=<***>                 # printf 'tok1'; sleep 2; printf 'simple\n'
+ : 'xtrace ***'
split across lines: tok1      # leaks
simple
reversed: elpmis1kot          # leaks
```

**Reference script (run 3).** checkA masks and runs the check in the same step. checkB is a later step with a fresh, unmasked parse of the secret: it is masked. `Q` is not over-masked:

```
##[warning]FACTORY_CHECK_ENV MULTI2 line 4 is shorter than 3 characters and is not masked
[checkA] PERCENT raw=<***>
[checkA] MULTI2 raw=<***

***
Q>
[checkB] SIMPLE raw=<***>
[checkB] ESCNL raw=<***
***>
Quick Question: QQQ
env has blob? no
chunked=<***>
```

**Step summary.** There is no REST endpoint for job summaries, so this rests on the runner source (`src/Runner.Worker/FileCommandManager.cs`, `CreateStepSummaryCommand`). The runner writes a `-scrubbed` copy of the summary file, built from `HostContext.SecretMasker.MaskSecrets(line)` for each line, and uploads that copy. It scrubs at the end of the step, so the scrub covers masks added at any point in the step, even values written before the mask. To check by eye, open the Summary of https://github.com/arwagner/af-spike-mask/actions/runs/44935068486 (job `checks`). Every `- [checkA] … summary=` line should show `***`.

The add-mask handler is `src/Runner.Worker/ActionCommandManager.cs`, `AddMaskCommandExtension`. It calls `AddValue(command.Data)`, then splits the data on `\r` and `\n` with `RemoveEmptyEntries | TrimEntries` and adds each line. `command.Data` is un-escaped (`%25`, `%0D`, `%0A`) by `ActionCommand.UnescapeData`.

## Method

1. One step at the start of the check sequence holds `FACTORY_CHECK_ENV`. It parses the secret with dotenv grammar, then registers the masks before anything else prints.
2. For a single-line value, it emits `::add-mask::` with the value escaped (`%` first, then `\r` and `\n`). It masks every length, so `t0` masks every `t0`.
3. For a multi-line value, it emits one escaped `::add-mask::` per line and never the whole value. Lines whose trimmed length is under 3 are skipped with a `::warning::` that names the key, not the value.
4. Commands are written synchronously, so the masks are registered before the check's own output.
5. Values reach the check process through its environment (`--` wrapper), not through `$GITHUB_ENV`. `$GITHUB_ENV` would also hand them to later agent steps in a turn-taking task (merge: agent, checks, agent).
6. Empty values are skipped. The runner warns on an empty add-mask.

## Reference script

`check-env.js` (Node, no dependencies; also in arwagner/af-spike-mask). Usage: `node check-env.js -- <check command>`.

```js
#!/usr/bin/env node
// Reference: mask the values of the dotenv-formatted FACTORY_CHECK_ENV in the job log,
// then (optionally) run a check command with those values in its environment.
//
//   node check-env.js                 # register masks only
//   node check-env.js -- <cmd> [args] # register masks, then run <cmd> with the values as env vars
//
// Masks registered with ::add-mask:: last for the rest of the job (not other jobs).
'use strict';
const fs = require('fs');
const { spawnSync } = require('child_process');

const MIN_LINE = 3; // lines of a multi-line value shorter than this are not masked (see pitfalls)

// Same grammar as the dotenv npm package (v16 parse()).
const LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg;
function parseDotenv(src) {
  const out = {};
  const text = String(src).replace(/\r\n?/mg, '\n');
  let m;
  LINE.lastIndex = 0;
  while ((m = LINE.exec(text)) != null) {
    let value = (m[2] || '').trim();
    const quote = value[0];
    value = value.replace(/^(['"`])([\s\S]*)\1$/mg, '$2');
    if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    out[m[1]] = value;
  }
  return out;
}

// Workflow-command data escaping (the runner un-escapes these before using the data).
const escapeData = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

// Write synchronously so every mask is registered before anything else prints.
const command = (s) => fs.writeSync(1, `${s}\n`);

function registerMasks(vars) {
  for (const [key, value] of Object.entries(vars)) {
    const lines = value.split(/\r\n|\r|\n/);
    if (lines.length === 1) {
      if (value.trim()) command(`::add-mask::${escapeData(value)}`);
      continue;
    }
    // Multi-line: one command per line, never the whole value. The runner would split a
    // whole value into lines itself and mask every one, including "}" or "-".
    lines.forEach((line, i) => {
      if (line.trim().length >= MIN_LINE) command(`::add-mask::${escapeData(line)}`);
      else if (line.trim()) command(`::warning::FACTORY_CHECK_ENV ${key} line ${i + 1} is shorter than ${MIN_LINE} characters and is not masked`);
    });
  }
}

function main() {
  const vars = parseDotenv(process.env.FACTORY_CHECK_ENV || '');
  registerMasks(vars);
  const sep = process.argv.indexOf('--');
  if (sep === -1) return;
  const [cmd, ...args] = process.argv.slice(sep + 1);
  const env = { ...process.env, ...vars };
  delete env.FACTORY_CHECK_ENV;
  const r = spawnSync(cmd, args, { stdio: 'inherit', env });
  if (r.error) throw r.error;
  process.exit(r.status ?? 1);
}

if (require.main === module) main();
module.exports = { parseDotenv, escapeData, registerMasks };
```

## Pitfalls

- **Escape before masking.** The runner un-escapes `%25`, `%0D` and `%0A` in command data. Without escaping, `a%0Ab` registers `a` and `b`, a long way from the real value.
- **Raw newlines end the command.** With `echo "::add-mask::$v"`, a multi-line `$v` prints every line after the first to the log, unmasked.
- **Short masks over-mask.** Every 1-character line of a masked multi-line value, and every short single-line value, is masked everywhere in the job log (`E***UALS`). That makes logs hard to read. It isn't a leak.
- **The secret's own lines are masks too.** GitHub registers each line of the `FACTORY_CHECK_ENV` blob, so whole dotenv source lines such as `SIMPLE=tok1simple` or a closing `Q"` get masked wherever they appear. Harmless.
- **Masks are per job.** Registering them in the route or apply job does nothing for the agent job, and the reverse.
- **Before the mask, nothing is hidden.** Output printed before the add-mask step (or earlier in the same step) stays in clear in the log. The summary is the exception, because it is scrubbed at the end of the step.
- **Masking covers the log and the summary, nothing else.** If the factory captures check output to show the agent (merge rounds) or puts it in a comment, transcript or artifact, those copies hold raw values. Scrub them with the same list of parsed values (and their lines).
- **Hostile check code wins.** Checks run code the agent wrote, and that code can split, reverse or re-encode values (see #18). Masking is a courtesy. The control is §8's rule that these values are low-value.

## Suggested spec changes

- **§8 Checks:** before the first check, the factory registers a log mask for each `FACTORY_CHECK_ENV` value in the agent job, using the method above. Each check step gets the secret and loads it into its own process environment, never through `$GITHUB_ENV`.
- **§8 or docs:** recommend single-line values of at least 3 characters.
- **§9 Leakage:** add "masking can't see a value split across lines". Also say that check output the factory captures for the agent, a comment or a transcript is scrubbed of the parsed values as well as the whole blob.
