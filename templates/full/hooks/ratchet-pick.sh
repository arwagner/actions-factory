#!/usr/bin/env bash
# ratchet's before hook (agent job, read-only GitHub token). The tracking issue names an exception list and the
# stricter check, on lines of their own:
#   ratchet-exceptions: path/to/exceptions.txt   (one entry per line; blank lines and # comments ignored)
#   ratchet-check: the command that must pass once an entry is fixed ({entry} is replaced by the entry)
# Picks one entry at random and tells the agent, in context.md.
set -euo pipefail
repo="$GITHUB_REPOSITORY"
out="$FACTORY_WORK_DIR/context.md"
stop() { echo "$1 Change nothing, and use the outcome \`not-fixed\` with a comment saying so." >"$out"; exit 0; }

body=$(gh api "repos/$repo/issues/$FACTORY_SUBJECT" --jq '.body // ""' | tr -d '\r')
file=$(sed -n 's/^ratchet-exceptions:[[:space:]]*//p' <<<"$body" | head -n 1)
check=$(sed -n 's/^ratchet-check:[[:space:]]*//p' <<<"$body" | head -n 1)

[ -n "$file" ] && [ -n "$check" ] || stop "Tracking issue #$FACTORY_SUBJECT needs a \`ratchet-exceptions:\` line and a \`ratchet-check:\` line."
case "$file" in /* | *..*) stop "\`ratchet-exceptions\` must be a path inside the repo, not $file." ;; esac
[ -f "$file" ] || stop "The exception list \`$file\` doesn't exist."

entry=$(grep -v -E '^[[:space:]]*(#|$)' "$file" | shuf -n 1 || true)
[ -n "$entry" ] || stop "The exception list \`$file\` is empty: the migration is done."

cat >"$out" <<EOF
This run fixes one entry of the exception list \`$file\`, picked at random:

    $entry

Make the code it names pass the stricter check, then remove that one line from \`$file\`. The check is:

    ${check//\{entry\}/$entry}

Run it. Only if it passes, use the outcome \`fixed\` and ask for a \`pullRequest\` whose body names the entry and
\`Part of #$FACTORY_SUBJECT\`. If it doesn't pass, undo your changes and use \`not-fixed\` with a comment on what
stood in the way. Fix nothing else.
EOF
