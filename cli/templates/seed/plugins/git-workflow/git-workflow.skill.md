# Git Workflow

## Branching

Always work on a feature branch, never directly on `main` or `master`.

```bash
git checkout -b feat/short-description
```

## Commits

Use conventional commits format:
- `feat:` — new feature
- `fix:` — bug fix
- `refactor:` — refactoring without behavior change
- `test:` — adding or updating tests
- `docs:` — documentation only

Keep commits atomic: one logical change per commit.

## Pull Requests

Before creating a PR:
1. Run tests: ensure they pass
2. Build: ensure it compiles
3. Review your own diff

Create PRs against `main`. Title should match the commit format.
