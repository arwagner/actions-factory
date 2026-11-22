#!/usr/bin/env bash
# implement-spec's after hook (apply job, FACTORY_TOKEN). After a split: links the new tickets as sub-issues of the
# spec, with blocking links from the plan's dependsOn. After a built ticket: closes it. Either way, adds the label to
# the spec again, which starts the next run (a label added with FACTORY_TOKEN starts workflows). When the spec is
# done, hands its pull request to review.
set -euo pipefail
repo="$GITHUB_REPOSITORY"
spec="$FACTORY_SUBJECT"
issue_id() { gh api "repos/$repo/issues/$1" --jq .id; }
again() { gh api -X POST "repos/$repo/issues/$spec/labels" -f "labels[]=$FACTORY_TASK_LABEL" --silent; }

case "$FACTORY_OUTCOME" in
  split)
    read -r -a created <<<"${FACTORY_CREATED_ISSUES:-}"
    for n in "${created[@]}"; do
      gh api -X POST "repos/$repo/issues/$spec/sub_issues" -F "sub_issue_id=$(issue_id "$n")" --silent
    done
    jq -r '(.dependsOn // []) | to_entries[] | .key as $i | .value[] | "\($i) \(.)"' <<<"$FACTORY_PLAN" |
      while read -r i j; do
        ticket="${created[$i]:-}" blocker="${created[$j]:-}"
        [ -n "$ticket" ] && [ -n "$blocker" ] || continue
        gh api -X POST "repos/$repo/issues/$ticket/dependencies/blocked_by" -F "issue_id=$(issue_id "$blocker")" --silent
      done
    again
    ;;
  built)
    ticket=$(jq -r '.ticket // empty' <<<"$FACTORY_PLAN")
    if [ -n "$ticket" ]; then
      gh api -X PATCH "repos/$repo/issues/$ticket" -f state=closed -f state_reason=completed --silent
    fi
    again
    ;;
  done)
    pr=$(gh api "repos/$repo/pulls?state=open&head=${repo%%/*}:agent/issue-$spec" --jq '.[0].number // empty')
    if [ -n "$pr" ]; then
      gh api -X POST "repos/$repo/issues/$pr/labels" -f "labels[]=agent:review" --silent
    fi
    ;;
esac
