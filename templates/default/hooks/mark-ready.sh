#!/usr/bin/env bash
# review's after hook: a pull request the review found ready leaves draft, for a person to merge.
# Marking ready exists only in GraphQL; this one mutation needs no scopes beyond the repo.
set -euo pipefail
if [ "${FACTORY_OUTCOME:-}" = "ready" ] && [ -n "${FACTORY_SUBJECT:-}" ]; then
  id=$(gh api "repos/$GITHUB_REPOSITORY/pulls/$FACTORY_SUBJECT" --jq .node_id)
  if [ "$(gh api "repos/$GITHUB_REPOSITORY/pulls/$FACTORY_SUBJECT" --jq .draft)" = "true" ]; then
    gh api graphql -f query='mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { clientMutationId } }' -f id="$id" --silent
  fi
fi
