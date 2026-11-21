# Identity and token options without a custom App

Ticket: [#3](https://github.com/arwagner/actions-factory/issues/3). Researched 2026-11-21 against docs.github.com and the `actions/create-github-app-token` repo.

## Question

Without the factory owning a GitHub App, which identities can a client repo give it, and what can each do? Compared: `GITHUB_TOKEN`, a fine-grained PAT, a classic PAT, and a client-owned GitHub App used through `actions/create-github-app-token`. For each: can its events trigger the next workflow, can it push changes under `.github/workflows`, how it shows in the audit trail and comments, setup effort, rotation, and org policy blockers.

## Answer in one line

Only a client-owned App token (or a PAT) both triggers the next label-driven workflow and pushes workflow files. `GITHUB_TOKEN` does neither, apart from `workflow_dispatch`/`repository_dispatch`.

## Comparison

| | `GITHUB_TOKEN` | Fine-grained PAT | Classic PAT | Client-owned App via `create-github-app-token` |
|---|---|---|---|---|
| Its events trigger other workflows (e.g. adding `agent:review`) | **No**, except `workflow_dispatch` and `repository_dispatch`; `pull_request` opened/synchronize/reopened run only after approval [1] | Yes [2] | Yes [2] | Yes [2] |
| Can push under `.github/workflows` | **No.** `permissions:` has no `workflows` key [3] (see note A) | Yes, with the **Workflows** repo permission [4] | Yes, with the `workflow` scope [5] | Yes, if the App has the **Workflows** permission [6] |
| Shows in comments/commits as | `github-actions[bot]` (see note B) | The human (or machine user) who owns the token [4] | The human (or machine user) who owns the token [4] | `<app-slug>[bot]`; commit email `<id>+<slug>[bot]@users.noreply.github.com` [7] |
| Audit log | App installation token | User as actor, plus `hashed_token`, `programmatic_access_type` [8] | Same, plus `token_scopes` [8] | Shown as the App installation [8] |
| Setup effort | None | Create token, store it as a secret; may need org approval [9] | Create token, store it as a secret | Register a private App in the client org, set permissions, install it, store client ID + private key [6][7][10] |
| Lifetime / rotation | Minted per job; expires at job end [1] | Expires; ≤366 days by default, org may cap it lower [9] | No expiry required by default; org may set a cap [9] | Token lasts 1 h and is revoked at job end [7]; the private key never expires, so rotation is manual |
| Scope | Only the repo the workflow runs in [1] | Selected repos in **one** owner (user or org) [4] | Everything the user can reach | Selected repos in the installation [7] |
| Org policy blockers | Org default can be read-only; org controls "Allow GitHub Actions to create and approve pull requests" [11] | Org can block fine-grained PATs; **admin approval is the default** [9] | Org can block classic PATs, and can set a max lifetime [9] | Only org owners (or repo admins, if allowed) can install it [10] |

## Findings

### Triggering the next task

- "events triggered by the `GITHUB_TOKEN` … will not create a new workflow run". `workflow_dispatch` and `repository_dispatch` "always create workflow runs". PR `opened`/`synchronize`/`reopened` events create runs that wait for approval [1][2]. So with `GITHUB_TOKEN`, a `labeled` event from adding `agent:review` **will not** start the review workflow.
- The docs' fix: "use a GitHub App installation access token or a personal access token instead of `GITHUB_TOKEN`" [2].
- One `GITHUB_TOKEN` workaround: the finishing task calls `workflow_dispatch` on the next task directly (needs `actions: write`) and adds the label only as a marker. *Inference; not tested.*

### Editing `.github/workflows`

- The `permissions:` keys for `GITHUB_TOKEN` are actions, artifact-metadata, attestations, checks, code-quality, contents, copilot-requests, deployments, discussions, id-token, issues, packages, pages, pull-requests, security-events, statuses and vulnerability-alerts. There is **no `workflows` key** [3].
- Classic `workflow` scope: "Grants the ability to add and update GitHub Actions workflow files." A workflow file can be committed without it only if the identical file (same path and contents) already exists on another branch [5].
- Fine-grained PAT: the Workflows permission is write-only and "Includes permission to edit workflow files for Actions" [4].
- GitHub App: request the Workflows permission "if your app specifically needs to access or edit Actions files in the `.github/workflows` directory" [6].

**Note A (uncertain):** No docs page says outright that `GITHUB_TOKEN` cannot push workflow files. That rests on the missing `permissions:` key [3], `GITHUB_TOKEN` being an App installation token [1], and the familiar push error "refusing to allow a GitHub App to create or update workflow … without `workflows` permission" ([community thread](https://github.community/t/refusing-to-allow-a-github-app-to-create-or-update-workflow-without-workflows-permission/182573), low trust). Worth a spike to confirm.

### Identity and audit

- `GITHUB_TOKEN` "is a GitHub App installation access token" scoped to the workflow's repo [1].
- **Note B (uncertain):** The `github-actions[bot]` display name is common knowledge, but none of the pages fetched for this research states it.
- PATs are "tied to the user who generated them" and carry that user's abilities, limited by scope [4]. To avoid acting as a human, the client creates a machine user and pays for its seat. *Paid-seat implication is an inference.*
- `create-github-app-token` outputs `token`, `installation-id` and `app-slug`. Its examples set the git committer to the App's bot identity [7].
- The org audit log records `hashed_token`, `programmatic_access_type` and `token_scopes` for PATs, OAuth tokens and App tokens [8].

### `create-github-app-token` details (v3) [7]

- Inputs: `client-id` (preferred; `app-id` is legacy), `private-key`, optional `owner`, `repositories`, `permission-<name>` (e.g. `permission-workflows: write`), and `skip-token-revoke`.
- "An installation access token expires after 1 hour." The `post` step revokes it, so it cannot be passed to another job. An agent run longer than an hour needs a fresh token, either by minting again or by splitting steps. *How the factory handles this is an open design question.*
- The README recommends `persist-credentials: false` on checkout so the default `GITHUB_TOKEN` isn't stored in git config.
- A private App "can only be installed on the account that created it" [12]. So **each client org registers its own App**. The factory can ship a manifest or instructions; it cannot ship a shared App without becoming the App owner that ADR-0001 rules out.

### Org policy (relevant to Skylight-hq)

- PAT policy [9]: PATs (both kinds) are enabled by default. Owners can block both. **Fine-grained PATs need owner approval by default**, and a pending token can only read public resources. Classic PATs skip approval unless the org restricts them. Owners can set maximum lifetimes.
- App install [10]: "Organization owners can install GitHub Apps on their organization." Repo admins can install an App on repos they administer if it asks for no org permissions and no "Repository administration" permission, unless owners have turned that off. Otherwise a member's install request goes to owners.
- Actions settings [11]: an org's restrictive default `GITHUB_TOKEN` permissions cannot be loosened per repo. "Allow GitHub Actions to create and approve pull requests" is inherited from the org.
- **Unknown:** Skylight-hq's actual settings. The client org has to be asked: are PATs allowed or approved, will an owner install a private App, and is Actions PR creation enabled?

## Implications for the factory (recommendation, not decided)

1. **Default identity: a client-owned private App through `create-github-app-token`.** It triggers chained workflows, can carry the Workflows permission, its tokens are short-lived, and it shows up as a distinct bot. Cost: one org-owner install per client.
2. **Fallback: a fine-grained PAT on a machine user.** It behaves like the App, but org approval is likely, it is tied to a seat, and it expires.
3. **Avoid classic PATs:** they reach everything the user can and need not expire.
4. **`GITHUB_TOKEN` alone** is a reduced mode only. It needs dispatch-based chaining, cannot change workflows, and creating PRs needs the org setting.
5. Make identity one swappable input, `token` / App credentials in `factory.yml` plus secrets, so a client can choose.

## Sources

1. GITHUB_TOKEN concepts: https://docs.github.com/en/actions/concepts/security/github_token
2. Triggering a workflow from a workflow: https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow
3. Workflow syntax, `permissions`: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
4. Managing personal access tokens: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
5. OAuth/classic scopes: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
6. Choosing permissions for a GitHub App: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app
7. actions/create-github-app-token README: https://github.com/actions/create-github-app-token
8. Audit log events by access token: https://docs.github.com/en/organizations/keeping-your-organization-secure/managing-security-settings-for-your-organization/identifying-audit-log-events-performed-by-an-access-token
9. Org PAT policy: https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/setting-a-personal-access-token-policy-for-your-organization
10. Installing a third-party GitHub App (install requirements): https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party
11. Repo Actions settings: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository
12. Installing your own GitHub App: https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app
