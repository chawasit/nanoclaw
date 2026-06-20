# COMPANY.md

This is a **downstream integration fork** of [`nanocoai/nanoclaw`](https://github.com/nanocoai/nanoclaw).

## Branch model

- **`main`** — a pure mirror of upstream `nanocoai/nanoclaw`. **Never commit here.**
  It exists only to track upstream and to merge from.
- **`company`** — our integration trunk (the branch deployments run from). Feature
  branches merge into `company` via `--no-ff`.

To pull upstream changes: update `main` from `upstream`, then merge `main` into `company`.

## Where the docs live

Detailed design notes, the per-step build journal, and operational SOPs are kept in a
**separate private repository**, not here. This fork holds **code only**.

> Public repo — keep internal infrastructure details (hosts, IPs, paths, credentials)
> out of anything committed here.
