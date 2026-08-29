## What

<!-- What does this change do? -->

## Why

<!-- Link the issue, or explain the motivation. -->

## Checklist

- [ ] `pnpm lint && pnpm typecheck && pnpm test` passes
- [ ] `cargo fmt --check && cargo clippy --all-targets -- -D warnings` passes
- [ ] Git access goes through `GitPort` (no direct `git` calls outside `crates/git-port`)
- [ ] `packages/core` still has no Tauri imports
