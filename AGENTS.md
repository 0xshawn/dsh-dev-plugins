# AGENTS.md

## Scope

`dsh-dev-plugins` is the public DeepSeek Harness (dsh) web bundle: the host
plugin in `lib/index.js`, the browser client in `lib/client.js`, the bundle
patch in `cordis.patch.yml`, and the install/behaviour docs in `README*.md`.
It is a multi-feature bundle: keep new plugin features in their own `lib/`
modules and document each one in both READMEs.

## Workflow

- Submit every code change through a pull request: start from synchronized
  `main`, create a feature branch, validate the change, open a PR (draft is
  fine), obtain independent review, and squash-merge. Never commit code
  directly to `main`.
- Keep code comments and commit messages in English.
- Update `CHANGELOG.md`, both READMEs, and the `package.json` version inside
  the PR when the change is user-visible. Push the release tag against the
  squash-merged `main` commit after the PR merges.

## Validation

- Run `npm test`; it covers the host patch/config/token seams and the browser
  notification client with Node's built-in test runner.
- For a change that affects served pages or deployment, verify the bundle
  against the dsh version pinned by the `hapi-deployment` repository and report
  the checks actually run; do not claim live validation that was not performed.
