# Studio v7 Workspace Setup Design

**Date:** 2026-02-13
**Status:** Approved
**Approach:** Sequential Dependency-Order Build

## Overview

This design covers the initial setup of the Studio v7 workspace with all 6 repositories (parent + 5 sub-repos) initialized and ready for Phase 1 implementation. The setup follows the multi-repo architecture defined in [architecture-studio-v7.md](../architecture/architecture-studio-v7.md).

## Goals

- Create studio-workspace parent repository
- Initialize all 5 sub-repositories with basic structure
- Configure package.json and tsconfig.json for each repo
- Set up local relative path dependencies
- Initialize local git repositories (no remote setup)
- Create basic test structure (no test runner installation)
- Generate setup.sh script for future reproducibility
- Validate each repo builds successfully before moving to next

## Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Setup Scope | Full workspace - all repos ready to code | Complete foundation before Phase 1 implementation |
| Git Setup | Local repos only | Version control without requiring GitHub setup |
| Dependencies | Local relative paths in package.json | Matches architecture "chemins relatifs" approach |
| Setup Method | Manual + create setup.sh for future | Immediate setup plus reproducibility |
| Testing | Basic structure, no test runner | Defer test infrastructure until implementation |
| Approach | Sequential dependency-order build | Validate each piece before moving on |

## Workspace Structure

```
studio-workspace/                  (current dir: /home/arianeguay/dev/src/Studio)
├── .gitignore                    (ignores all sub-repos)
├── README.md                     (overview + quick start)
├── setup.sh                      (executable setup script)
├── package.json                  (workspace-level scripts)
├── docs/
│   ├── architecture/
│   │   └── architecture-studio-v7.md  (exists)
│   └── plans/
│       └── 2026-02-13-studio-v7-workspace-setup-design.md  (this file)
│
├── contracts/                    (git repo, @studio/contracts)
├── ralph/                        (git repo, @studio/ralph)
├── runner/                       (git repo, @studio/runner)
├── engine/                       (git repo, @studio/engine)
└── cli/                          (git repo, @studio/cli)
```

### Key Decisions

- **Not using git submodules:** Each sub-repo is independent, just ignored in parent .gitignore
- **Parent tracks:** Only workspace-level files (docs, setup.sh, workspace package.json)
- **Sub-repos are standalone:** Can be versioned and potentially published independently

## Configuration Files

### Standard package.json Template

Used across all sub-repos with appropriate modifications:

```json
{
  "name": "@studio/<repo-name>",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    // Example: "@studio/contracts": "file:../contracts"
  },
  "devDependencies": {
    "typescript": "^5.3.0"
  }
}
```

### Standard tsconfig.json Template

Consistent across all repos:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

### Parent Workspace package.json

```json
{
  "name": "studio-workspace",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build:all": "npm run build --workspaces",
    "clean:all": "npm run clean --workspaces",
    "test:all": "echo 'Tests will be added per repo'"
  }
}
```

### Standard .gitignore

```
node_modules/
dist/
*.log
.env
.DS_Store
```

## Sequential Build Order

### Step 1: studio-workspace (Parent)

**Actions:**
- Initialize as git repo
- Create `.gitignore` listing all sub-repo directories
- Create workspace `package.json`
- Create `setup.sh` script (functional but not used for this setup)
- Preserve existing `docs/` structure
- Add `README.md` with architecture overview and quick start

**Files created:**
- `.gitignore`
- `package.json`
- `README.md`
- `setup.sh`

### Step 2: studio-contracts (Foundation)

**Structure:**
```
contracts/
├── .gitignore
├── package.json          (@studio/contracts, no dependencies)
├── tsconfig.json
├── ARCHITECTURE.md
├── src/
│   ├── index.ts          (export barrel)
│   ├── pipeline.ts       (PipelineDefinition, StageDefinition)
│   ├── stage.ts          (StageStatus, StageKind, StageResult)
│   ├── task.ts           (TaskStatus, TaskResult, TaskConfig)
│   ├── agent.ts          (AgentConfig, AgentProfile, ToolCall)
│   ├── run.ts            (PipelineRun, StageRun, TaskRun, AgentRun)
│   ├── validation.ts     (OutputContract, ValidationResult, ValidationRule)
│   ├── provider.ts       (LLMProvider, LLMRequest, LLMResponse, ToolDefinition)
│   └── errors.ts         (StudioError, error codes enum)
└── tests/
    └── types.test.ts     (placeholder file)
```

**Actions:**
- Create directory structure
- Add all configuration files
- Create placeholder TypeScript files (type definitions, empty for now)
- Copy ARCHITECTURE.md from architecture doc template
- Git init
- npm install
- Validate: `npm run build` succeeds

**Dependencies:** None (leaf package)

### Step 3: studio-ralph

**Structure:**
```
ralph/
├── .gitignore
├── package.json          (depends on @studio/contracts)
├── tsconfig.json
├── ARCHITECTURE.md
├── src/
│   ├── index.ts
│   ├── loop.ts
│   ├── validator.ts
│   ├── contracts.ts
│   ├── retry-strategy.ts
│   └── context-enricher.ts
├── tests/
│   ├── loop.test.ts
│   ├── validator.test.ts
│   └── retry.test.ts
└── configs/
    └── examples/
        ├── code-generation.contract.yaml
        └── analysis.contract.yaml
```

**Actions:**
- Create directory structure
- Add package.json with `"@studio/contracts": "file:../contracts"`
- Create placeholder TypeScript files
- Add example YAML contracts
- Copy ARCHITECTURE.md template
- Git init
- npm install (will link contracts via file:)
- Validate: builds and can import from @studio/contracts

**Dependencies:** @studio/contracts

### Step 4: studio-runner

**Structure:**
```
runner/
├── .gitignore
├── package.json          (depends on @studio/contracts)
├── tsconfig.json
├── ARCHITECTURE.md
├── src/
│   ├── index.ts
│   ├── runner.ts
│   ├── providers/
│   │   ├── provider.ts
│   │   ├── openai.ts
│   │   ├── anthropic.ts
│   │   └── registry.ts
│   ├── tools/
│   │   ├── tool-executor.ts
│   │   ├── tool-registry.ts
│   │   └── builtin/
│   │       ├── repo-manager.ts
│   │       ├── shell.ts
│   │       └── search.ts
│   ├── prompt-builder.ts
│   └── context/
│       ├── context-pack.ts
│       └── context-sources.ts
├── tests/
│   ├── runner.test.ts
│   ├── openai.test.ts
│   ├── anthropic.test.ts
│   ├── tool-executor.test.ts
│   └── prompt-builder.test.ts
└── configs/
    └── agents/
        ├── generic.agent.yaml
        ├── code-generator.agent.yaml
        └── analyst.agent.yaml
```

**Actions:**
- Create directory structure
- Add package.json with contracts dependency
- Create placeholder TypeScript files
- Add example agent YAML configs
- Copy ARCHITECTURE.md template
- Git init
- npm install
- Validate: builds and imports contracts

**Dependencies:** @studio/contracts

### Step 5: studio-engine

**Structure:**
```
engine/
├── .gitignore
├── package.json          (depends on contracts, ralph, runner + prisma)
├── tsconfig.json
├── ARCHITECTURE.md
├── src/
│   ├── index.ts
│   ├── engine.ts
│   ├── state/
│   │   ├── state-machine.ts
│   │   ├── status-derivation.ts
│   │   └── run-store.ts
│   ├── pipeline/
│   │   ├── loader.ts
│   │   ├── stage-resolver.ts
│   │   └── context-propagation.ts
│   ├── db/
│   │   ├── client.ts
│   │   └── migrations/
│   └── events.ts
├── tests/
│   ├── engine.test.ts
│   ├── state-machine.test.ts
│   ├── status-derivation.test.ts
│   ├── loader.test.ts
│   └── e2e/
│       └── feature-v5.test.ts
├── prisma/
│   └── schema.prisma     (placeholder)
└── pipelines/
    └── feature-builder.pipeline.yaml
```

**Actions:**
- Create directory structure
- Add package.json with contracts, ralph, runner, prisma dependencies
- Create placeholder TypeScript files
- Add placeholder Prisma schema
- Add example pipeline YAML
- Copy ARCHITECTURE.md template
- Git init
- npm install
- Validate: builds and imports all dependencies

**Dependencies:** @studio/contracts, @studio/ralph, @studio/runner, prisma

### Step 6: studio-cli

**Structure:**
```
cli/
├── .gitignore
├── package.json          (depends on contracts, engine; has bin: "studio")
├── tsconfig.json
├── ARCHITECTURE.md
├── src/
│   ├── index.ts
│   ├── commands/
│   │   ├── run.ts
│   │   ├── validate.ts
│   │   ├── list.ts
│   │   ├── status.ts
│   │   └── init.ts
│   ├── output/
│   │   ├── formatter.ts
│   │   ├── logger.ts
│   │   └── progress.ts
│   └── config.ts
├── tests/
│   └── commands/
│       ├── run.test.ts
│       └── status.test.ts
└── templates/
    ├── .studiorc.yaml
    └── pipelines/
        └── hello-world.pipeline.yaml
```

**Actions:**
- Create directory structure
- Add package.json with contracts, engine dependencies and bin config
- Create placeholder TypeScript files
- Add template YAML files
- Copy ARCHITECTURE.md template
- Git init
- npm install
- Validate: builds and imports engine

**Dependencies:** @studio/contracts, @studio/engine

## Validation Strategy

### Per-Repo Validation

After each repo setup:

1. **File structure check**
   ```bash
   ls -la <repo>/src
   ls -la <repo>/tests
   ```

2. **TypeScript compilation**
   ```bash
   cd <repo>
   npm install
   npm run build
   ```

3. **Dependency resolution** (for repos with dependencies)
   ```bash
   node -e "import('@studio/<dependency>').then(() => console.log('✓'))"
   ```

4. **Git status**
   ```bash
   git status
   ```

### Final Validation

After all repos are set up:

- Navigate to each repo and run `npm run build` successfully
- Verify dependency chain: cli → engine → (ralph, runner) → contracts
- Check all ARCHITECTURE.md files exist and match templates
- Verify parent workspace `.gitignore` includes all sub-repos
- Test workspace-level scripts: `npm run build:all`

### What's NOT Validated

- Test runners (not installed yet)
- Actual implementation code (placeholders only)
- Prisma migrations (schema only)
- LLM API connectivity (no keys configured)
- YAML config validity (examples only)

## setup.sh Script

### Purpose

Document the setup process and allow future recreation of the workspace structure.

### Contents

```bash
#!/bin/bash
# Studio v7 Workspace Setup Script

set -e  # Exit on error

echo "Setting up Studio v7 workspace..."

# Create all repo directories
mkdir -p contracts ralph runner engine cli

# For each repo:
#   1. Initialize as git repo
#   2. Create basic structure (src/, tests/)
#   3. Generate package.json with correct dependencies
#   4. Generate tsconfig.json
#   5. Copy ARCHITECTURE.md template
#   6. Create .gitignore
#   7. npm install

# Setup workspace-level files
# Create parent .gitignore
# Create parent package.json

echo "✓ Workspace setup complete!"
echo "Next steps:"
echo "  1. cd contracts && npm run build"
echo "  2. Start implementing Phase 1 (contracts)"
```

### Usage

- **Not used for initial setup:** We'll create structure directly
- **For future use:** Recreate workspace from scratch
- **Documentation:** Shows contributors how structure was created
- **Executable:** `chmod +x setup.sh`

## Success Criteria

Setup is complete when:

1. ✅ All 6 repos exist with proper directory structure
2. ✅ Each sub-repo is a git repository with clean status
3. ✅ Each sub-repo has package.json, tsconfig.json, ARCHITECTURE.md, .gitignore
4. ✅ All repos build successfully (`npm run build`)
5. ✅ Dependencies resolve correctly via file: paths
6. ✅ Parent workspace has functional scripts (build:all, clean:all)
7. ✅ setup.sh script is created and executable
8. ✅ All ARCHITECTURE.md templates match architecture doc
9. ✅ Test directories exist with placeholder files
10. ✅ Ready to start Phase 1 (contracts implementation)

## Out of Scope

This setup does NOT include:

- Test framework installation (Vitest/Jest)
- Actual TypeScript implementation code
- Prisma migrations execution
- LLM provider API keys or configuration
- Remote git repository creation
- Publishing packages to npm
- CI/CD configuration
- Linting or formatting tools setup

These will be added during Phase 1+ implementation.

## Next Steps

After setup is complete:

1. **Phase 1:** Implement @studio/contracts
   - Define all TypeScript interfaces
   - Add type-level tests
   - Validate with architecture doc

2. **Phase 2:** Implement @studio/ralph
   - Build RALPH loop
   - Add validation engine
   - Write unit tests

3. **Continue:** Follow architecture doc build order through Phase 5

## References

- [Architecture v7](../architecture/architecture-studio-v7.md)
- Build order: workspace → contracts → ralph → runner → engine → cli
- Final goal: `studio run feature-builder --input "Add FAQ to About page"` passes 10/10 times
