# Studio v7 Workspace

**Multi-repo workspace for Studio v7** - A complete rewrite with clean architecture.

## Architecture

Studio v7 follows a multi-repo structure with clear dependency chains:

```
                    @studio/contracts
                    /       |        \
                   /        |         \
          @studio/ralph  @studio/runner  |
                   \        /            |
                    \      /             |
                  @studio/engine         |
                        |               /
                        |              /
                    @studio/cli ------
```

## Repositories

- **contracts** - Shared TypeScript types and interfaces (zero dependencies)
- **ralph** - RALPH loop engine for retry with validation
- **runner** - Multi-provider LLM agent runner with tool execution
- **engine** - Pipeline orchestrator with SQLite persistence
- **cli** - Command-line interface (bin: studio)

## Quick Start

```bash
# Build all repos
npm run build:all

# Start implementing Phase 1
cd contracts
npm run dev
```

## Setup

This workspace was initialized using the sequential dependency-order approach. Each repo is independent with local file: dependencies during development.

See `docs/architecture/architecture-studio-v7.md` for full architecture details.

## Development

Each repo has:
- `npm run build` - Compile TypeScript
- `npm run dev` - Watch mode
- `npm run clean` - Remove dist/

## Goals

**Success criteria:** `studio run feature-builder --input "Add FAQ to About page"` passes 10/10 times.
