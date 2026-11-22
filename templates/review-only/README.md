# review-only

The easiest way to try the factory: it only reviews pull requests.

```yaml
schemaVersion: 1
template: review-only
```

Add `agent:review` to a pull request. The factory reviews it against the issue it closes and the repo's documented standards, and posts a verdict with every finding and the fix it would make. It changes no code: the branch is yours. A pull request it finds ready leaves draft.

It's [`default`](../default/README.md) with every other task removed, so moving up later is one line: delete `template: review-only`.
