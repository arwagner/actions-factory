# Dependabot bumps for reusable-workflow refs

Research for #26. Researched 2026-11-21 against primary sources: the GitHub docs, the GitHub changelog, and dependabot-core source at commit [`cbabeb7`](https://github.com/dependabot/dependabot-core/tree/cbabeb7b1671021a093ac3990c9e0ac17dc20fdd/github_actions/lib/dependabot/github_actions). Nothing here was tested end to end.

## Question

Does Dependabot (`package-ecosystem: github-actions`) open bump PRs for a job-level `uses:` ref to a reusable workflow, such as `owner/repo/.github/workflows/x.yml@vX.Y.Z` or a pinned SHA with a version comment? Does it work when the workflow is in a repo owned by another account, or in a private repo?

## Answer

- **Yes, for reusable workflows.** This has been supported since March 2023, both for tags and for SHA pins.
- **Yes, across owners, when the factory repo is public.** Nothing in the code limits refs to the client's own owner.
- **Private repos work only with extra setup.** A repo in the same org needs an org owner to grant Dependabot access. A private repo owned by a different account needs a `git` registry with a token in the client's `dependabot.yml`.

## Evidence

### Reusable workflows are supported

- GitHub changelog, 2023-03-13: Dependabot version updates can keep versioned reusable workflows up to date, whether they are pinned by commit SHA or by tag. [Dependabot updates support reusable workflows for GitHub Actions](https://github.blog/changelog/2023-03-13-dependabot-updates-support-reusable-workflows-for-github-actions/)
- GitHub docs: "reusable workflows used inside workflows are kept up to date". [Keeping your actions up to date with Dependabot](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/keeping-your-actions-up-to-date-with-dependabot)
- Source, `constants.rb`: `GITHUB_REPO_REFERENCE` captures `owner/repo`, an optional `path`, and `@ref`, so `owner/repo/.github/workflows/x.yml@v1.2.3` matches. [constants.rb](https://github.com/dependabot/dependabot-core/blob/cbabeb7b1671021a093ac3990c9e0ac17dc20fdd/github_actions/lib/dependabot/github_actions/constants.rb)
- Source, `workflow_file/uses_collector.rb`: the parser walks `jobs` and collects every `uses:` it finds there. That includes a job-level `jobs.<id>.uses` (a reusable-workflow call), not only step-level `uses:`. [uses_collector.rb](https://github.com/dependabot/dependabot-core/blob/cbabeb7b1671021a093ac3990c9e0ac17dc20fdd/github_actions/lib/dependabot/github_actions/workflow_file/uses_collector.rb)
- Source, `file_parser.rb#github_dependency`: there is an explicit branch for reusable workflows. When the path matches `/.github/workflows/*.ya?ml`, the dependency is named `owner/repo/.github/workflows/x.yml`, and its source is the git repo `https://github.com/owner/repo`. [file_parser.rb](https://github.com/dependabot/dependabot-core/blob/cbabeb7b1671021a093ac3990c9e0ac17dc20fdd/github_actions/lib/dependabot/github_actions/file_parser.rb)
- Local refs such as `./.github/workflows/x.yml` are ignored. That doesn't affect us, because the stub calls the factory by a remote ref. [Supported ecosystems: GitHub Actions](https://docs.github.com/en/code-security/dependabot/ecosystems-supported-by-dependabot/supported-ecosystems-and-repositories)

### Each pin form behaves differently

Source: `update_checker.rb#updated_ref` and the per-source precision comments. [update_checker.rb](https://github.com/dependabot/dependabot-core/blob/cbabeb7b1671021a093ac3990c9e0ac17dc20fdd/github_actions/lib/dependabot/github_actions/update_checker.rb)

| Stub pin | Dependabot behaviour |
|---|---|
| `@vX.Y.Z` | Bumps to the newest tag with the same precision, which is three segments. |
| `@<sha> # vX.Y.Z` | Bumps to the commit SHA of the newest tag. The docs say it updates the version comment when the comment is on the same line ([Supported ecosystems](https://docs.github.com/en/code-security/dependabot/ecosystems-supported-by-dependabot/supported-ecosystems-and-repositories)). If the SHA has no tag, it moves to the latest commit instead, which may not be a release. |
| `@v1` | Precision matches the ref, so it opens a PR to `@v2` when a `v2` tag appears. Fixes inside v1 still arrive without a PR because the tag moves. |
| `@latest` | Not version-like and not a SHA, so Dependabot never bumps it. That's fine, because the tag itself moves. |

### Other owners and private repos

- **Public repo under another owner.** The source is a plain `https://github.com/owner/repo` git URL, read through `git ls-remote`-style tag fetches. No check compares it with the client's owner. GitHub's docs give `actions/checkout@<commit>` as the example form, which is itself a third-party owner from any client's point of view. `arwagner/actions-factory` is **public**, so this is the path every client takes.
- **Private repos in general.** "Dependabot supports both public and private repositories for GitHub Actions." For private repos, the docs point to the `git` private-registry type. [Supported ecosystems: GitHub Actions](https://docs.github.com/en/code-security/dependabot/ecosystems-supported-by-dependabot/supported-ecosystems-and-repositories)
- **Private or internal repo in the same org.** An org owner grants Dependabot access to the host repo. Internal repos can get permanent org-wide access, which needs GHAS. Private repos are granted one at a time with a checkbox, and repos created later aren't included automatically. [Changelog 2025-06-03](https://github.blog/changelog/2025-06-03-its-now-easier-to-grant-dependabot-access-to-repositories-from-the-organization-level/), [REST: Dependabot repository access](https://docs.github.com/en/rest/dependabot/repository-access)
- **Private repo owned by a different account.** The org grant above only covers repos inside the client's own org. Every source found describes it as "repositories in your organization". The documented route is a `git` registry in the client's `dependabot.yml`, with a token stored as a Dependabot secret: [Configuring access to private registries](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/manage-your-dependency-security/configure-access-to-private-registries)
  ```yaml
  registries:
    github:
      type: git
      url: https://github.com
      username: x-access-token
      password: ${{secrets.MY_GITHUB_PERSONAL_TOKEN}}
  updates:
    - package-ecosystem: github-actions
      directory: /
      schedule: { interval: weekly }
      registries: [github]
  ```
  The token must be able to read the private repo. This is inference from the docs and wasn't tested.

## Caveats

- Nothing was run against a live repo. The conclusions come from the docs, the changelog and current source.
- Enterprises that limit Actions to an allowlist can block Dependabot unless the needed actions and reusable workflows are allowed. [Troubleshooting Dependabot on GitHub Actions](https://docs.github.com/en/code-security/reference/supply-chain-security/troubleshoot-dependabot/dependabot-on-actions)
- The client has to enable Dependabot version updates for `github-actions` (a `dependabot.yml`). Nothing happens by default.

## Implications for the spec (section 11)

- The assumption holds for exact-pin clients (`@vX.Y.Z`, or a SHA with a same-line `# vX.Y.Z` comment) because the factory repo is public.
- Worth adding:
  - A SHA pin should carry a same-line version comment and point at a tagged commit. Otherwise Dependabot falls back to the latest commit, which may be unreleased `main`.
  - Dependabot opens major-bump PRs for `@v1` clients. That's harmless, but onboarding docs should mention it.
  - Dependabot only acts if the client has a `dependabot.yml` with `github-actions`. Onboarding (section 12) could ship one next to the stub for exact-pin clients.
  - If the factory repo ever goes private, Dependabot bumps break for clients in other accounts unless they add a `git` registry with a token.
