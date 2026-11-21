#!/usr/bin/env bash
# review's after hook: a pull request the review found ready leaves draft, for a person to merge.
set -euo pipefail
if [ "${FACTORY_OUTCOME:-}" = "ready" ] && [ -n "${FACTORY_SUBJECT:-}" ]; then
  gh pr ready "$FACTORY_SUBJECT" -R "$GITHUB_REPOSITORY"
fi
