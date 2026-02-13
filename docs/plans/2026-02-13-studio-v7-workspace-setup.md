# Studio v7 Workspace Setup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Set up complete Studio v7 multi-repo workspace with all 6 repos initialized, configured, and ready for Phase 1 implementation.

**Architecture:** Sequential dependency-order build. Each repo is set up completely with validation before moving to the next. Parent workspace → contracts (leaf) → ralph → runner → engine → cli. Each repo gets package.json, tsconfig.json, ARCHITECTURE.md, git init, and build validation.

**Tech Stack:** TypeScript 5.3+, Node.js ESM modules, npm with file: dependencies, Git, YAML configs

---

## Task 1: Parent Workspace Setup

**Files:**
- Create: `.gitignore`
- Create: `package.json`
- Create: `README.md`
- Create: `setup.sh`
- Modify: None (git already initialized)

**Step 1: Create parent .gitignore**

```bash
cat > .gitignore << 'EOF'
# Sub-repos (each has own git)
/contracts/
/ralph/
/runner/
/engine/
/cli/

# Node
node_modules/
dist/
*.log
.env
.DS_Store

# IDE
.vscode/
.idea/
*.swp
*.swo
EOF
```

**Step 2: Create parent package.json**

```bash
cat > package.json << 'EOF'
{
  "name": "studio-workspace",
  "version": "0.1.0",
  "private": true,
  "description": "Studio v7 - Multi-repo workspace for agentic pipeline orchestration",
  "scripts": {
    "build:all": "cd contracts && npm run build && cd ../ralph && npm run build && cd ../runner && npm run build && cd ../engine && npm run build && cd ../cli && npm run build",
    "clean:all": "cd contracts && npm run clean; cd ../ralph && npm run clean; cd ../runner && npm run clean; cd ../engine && npm run clean; cd ../cli && npm run clean",
    "test:all": "echo 'Tests will be added per repo'"
  }
}
EOF
```

**Step 3: Create README.md**

```bash
cat > README.md << 'EOF'
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
EOF
```

**Step 4: Create setup.sh script**

```bash
cat > setup.sh << 'EOF'
#!/bin/bash
# Studio v7 Workspace Setup Script
# Recreates the entire workspace structure from scratch

set -e  # Exit on error

echo "🏗️  Setting up Studio v7 workspace..."

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper function
setup_repo() {
    local repo=$1
    local deps=$2

    echo -e "${BLUE}Setting up $repo...${NC}"

    mkdir -p "$repo"
    cd "$repo"

    # Git init
    git init
    git branch -m main

    # Create directory structure
    mkdir -p src tests

    # Create .gitignore
    cat > .gitignore << 'GITIGNORE'
node_modules/
dist/
*.log
.env
.DS_Store
GITIGNORE

    # Create package.json (will be customized per repo)
    # Create tsconfig.json (standard across all)
    # Create ARCHITECTURE.md (from templates)
    # Create placeholder src/index.ts

    # npm install
    npm install

    # Build to validate
    npm run build

    cd ..
    echo -e "${GREEN}✓ $repo complete${NC}"
}

# Create main repos directories
mkdir -p contracts ralph runner engine cli

# Setup each repo (detailed implementation would go here)
echo -e "${BLUE}Setup complete!${NC}"
echo ""
echo "Next steps:"
echo "  1. cd contracts && npm run build"
echo "  2. Start implementing Phase 1 (contracts)"
EOF

chmod +x setup.sh
```

**Step 5: Commit parent workspace files**

```bash
git add .gitignore package.json README.md setup.sh
git commit -m "feat: initialize Studio v7 workspace structure

- Add parent .gitignore (excludes all sub-repos)
- Add workspace package.json with build:all script
- Add README with architecture overview
- Add setup.sh for future reproducibility

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

**Expected:** Clean commit, ready for sub-repos.

---

## Task 2: contracts Repo - Directory Structure

**Files:**
- Create: `contracts/` directory
- Create: `contracts/src/` directory
- Create: `contracts/tests/` directory
- Create: `contracts/configs/` directory (for future)

**Step 1: Create directory structure**

```bash
mkdir -p contracts/src contracts/tests
cd contracts
```

**Step 2: Initialize git**

```bash
git init
git branch -m main
git config user.email "ariane.dguay@gmail.com"
git config user.name "Ariane Guay"
```

**Expected:** New git repo initialized in contracts/

---

## Task 3: contracts Repo - Configuration Files

**Files:**
- Create: `contracts/.gitignore`
- Create: `contracts/package.json`
- Create: `contracts/tsconfig.json`

**Step 1: Create .gitignore**

```bash
cat > .gitignore << 'EOF'
node_modules/
dist/
*.log
.env
.DS_Store
EOF
```

**Step 2: Create package.json**

```bash
cat > package.json << 'EOF'
{
  "name": "@studio/contracts",
  "version": "0.1.0",
  "description": "Shared TypeScript types and interfaces for Studio v7",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "clean": "rm -rf dist",
    "typecheck": "tsc --noEmit"
  },
  "keywords": ["studio", "types", "contracts"],
  "author": "Ariane Guay",
  "license": "ISC",
  "devDependencies": {
    "typescript": "^5.3.0"
  }
}
EOF
```

**Step 3: Create tsconfig.json**

```bash
cat > tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
EOF
```

**Expected:** Three config files created.

---

## Task 4: contracts Repo - ARCHITECTURE.md

**Files:**
- Create: `contracts/ARCHITECTURE.md`

**Step 1: Create ARCHITECTURE.md**

```bash
cat > ARCHITECTURE.md << 'EOF'
# @studio/contracts

Types et interfaces partagés par tous les packages Studio. ZERO logique.

## Règles

- Ce package n'a AUCUNE dépendance
- JAMAIS de logique, uniquement des types/interfaces/enums TypeScript
- Tout changement ici impacte TOUS les autres repos — être conservateur
- Exporter tout depuis index.ts

## Fichiers clés

- `pipeline.ts` — PipelineDefinition, StageDefinition
- `stage.ts` — StageStatus, StageKind, StageResult
- `task.ts` — TaskStatus, TaskResult, TaskConfig
- `agent.ts` — AgentConfig, AgentProfile, ToolCall
- `run.ts` — PipelineRun, StageRun, TaskRun, AgentRun
- `validation.ts` — OutputContract, ValidationResult, ValidationRule
- `provider.ts` — LLMProvider, LLMRequest, LLMResponse, ToolDefinition
- `errors.ts` — StudioError, error codes enum

## Test

```bash
npm test  # compile-time type checks uniquement
```

## Philosophy

This is the foundation. Keep it stable. Keep it simple. Keep it pure types.
EOF
```

**Expected:** ARCHITECTURE.md created.

---

## Task 5: contracts Repo - Placeholder Source Files

**Files:**
- Create: `contracts/src/index.ts`
- Create: `contracts/src/pipeline.ts`
- Create: `contracts/src/stage.ts`
- Create: `contracts/src/task.ts`
- Create: `contracts/src/agent.ts`
- Create: `contracts/src/run.ts`
- Create: `contracts/src/validation.ts`
- Create: `contracts/src/provider.ts`
- Create: `contracts/src/errors.ts`

**Step 1: Create src/index.ts (export barrel)**

```bash
cat > src/index.ts << 'EOF'
// Export barrel for @studio/contracts
// All types are re-exported from their source files

export * from './pipeline.js';
export * from './stage.js';
export * from './task.js';
export * from './agent.js';
export * from './run.js';
export * from './validation.js';
export * from './provider.js';
export * from './errors.js';
EOF
```

**Step 2: Create src/pipeline.ts**

```bash
cat > src/pipeline.ts << 'EOF'
// Pipeline and Stage definitions

export interface PipelineDefinition {
  name: string;
  description: string;
  version: number;
  stages: StageDefinition[];
}

export interface StageDefinition {
  name: string;
  kind: string;
  agent: string;
  contract?: string;
  ralph?: {
    max_attempts: number;
    retry_strategy: string;
  };
  context?: {
    include: string[];
  };
  tools?: {
    required?: string[];
  };
}
EOF
```

**Step 3: Create src/stage.ts**

```bash
cat > src/stage.ts << 'EOF'
// Stage status and results

export type StageStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export type StageKind = 'analysis' | 'planning' | 'code_generation' | 'qa' | 'custom';

export interface StageResult {
  status: StageStatus;
  output?: unknown;
  error?: string;
  attempts: number;
  duration_ms: number;
}
EOF
```

**Step 4: Create src/task.ts**

```bash
cat > src/task.ts << 'EOF'
// Task configuration and results

export type TaskStatus = 'pending' | 'running' | 'success' | 'failed';

export interface TaskConfig {
  name: string;
  description?: string;
  timeout_ms?: number;
}

export interface TaskResult {
  status: TaskStatus;
  output?: unknown;
  error?: string;
  duration_ms: number;
}
EOF
```

**Step 5: Create src/agent.ts**

```bash
cat > src/agent.ts << 'EOF'
// Agent configuration and profiles

export interface AgentConfig {
  name: string;
  description?: string;
  provider: string;
  model: string;
  system_prompt?: string;
  tools?: string[];
  temperature?: number;
  max_tokens?: number;
}

export interface AgentProfile extends AgentConfig {
  // Additional profile-specific fields
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  error?: string;
}
EOF
```

**Step 6: Create src/run.ts**

```bash
cat > src/run.ts << 'EOF'
// Runtime execution tracking

export interface PipelineRun {
  id: string;
  pipeline_name: string;
  status: string;
  started_at: string;
  completed_at?: string;
  stages: StageRun[];
}

export interface StageRun {
  id: string;
  stage_name: string;
  status: string;
  started_at: string;
  completed_at?: string;
  tasks: TaskRun[];
}

export interface TaskRun {
  id: string;
  task_name: string;
  status: string;
  started_at: string;
  completed_at?: string;
  agent_runs: AgentRun[];
}

export interface AgentRun {
  id: string;
  agent_name: string;
  attempt: number;
  status: string;
  tool_calls: number;
  started_at: string;
  completed_at?: string;
  output?: unknown;
  error?: string;
}
EOF
```

**Step 7: Create src/validation.ts**

```bash
cat > src/validation.ts << 'EOF'
// Validation contracts and results

export interface OutputContract {
  name: string;
  version: number;
  schema?: {
    required_fields?: string[];
    [key: string]: unknown;
  };
  tool_calls?: {
    minimum?: number;
    required_tools?: string[];
  };
  custom_rules?: ValidationRule[];
}

export interface ValidationRule {
  name: string;
  description: string;
  check: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
EOF
```

**Step 8: Create src/provider.ts**

```bash
cat > src/provider.ts << 'EOF'
// LLM provider interfaces

export interface LLMProvider {
  name: string;
  call(request: LLMRequest): Promise<LLMResponse>;
}

export interface LLMRequest {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  max_tokens?: number;
}

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  content: string;
  tool_calls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  finish_reason: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
EOF
```

**Step 9: Create src/errors.ts**

```bash
cat > src/errors.ts << 'EOF'
// Error types and codes

export enum ErrorCode {
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  AGENT_EXECUTION_FAILED = 'AGENT_EXECUTION_FAILED',
  STAGE_FAILED = 'STAGE_FAILED',
  PIPELINE_FAILED = 'PIPELINE_FAILED',
  RALPH_EXHAUSTED = 'RALPH_EXHAUSTED',
  TOOL_EXECUTION_FAILED = 'TOOL_EXECUTION_FAILED',
  PROVIDER_ERROR = 'PROVIDER_ERROR',
  CONFIGURATION_ERROR = 'CONFIGURATION_ERROR',
}

export class StudioError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'StudioError';
  }
}
EOF
```

**Expected:** All 9 source files created with placeholder types.

---

## Task 6: contracts Repo - Test Placeholder

**Files:**
- Create: `contracts/tests/types.test.ts`

**Step 1: Create test placeholder**

```bash
cat > tests/types.test.ts << 'EOF'
// Type-level tests for @studio/contracts
// These tests verify that types compile correctly

import type {
  PipelineDefinition,
  StageDefinition,
  StageStatus,
  AgentConfig,
  ValidationResult,
} from '../src/index.js';

// Test: Can create valid pipeline definition
const pipeline: PipelineDefinition = {
  name: 'test-pipeline',
  description: 'Test pipeline',
  version: 1,
  stages: [],
};

// Test: Can create valid stage definition
const stage: StageDefinition = {
  name: 'test-stage',
  kind: 'analysis',
  agent: 'test-agent',
};

// Test: Status types are correct
const status: StageStatus = 'success';

// Test: Can create agent config
const agent: AgentConfig = {
  name: 'test-agent',
  provider: 'openai',
  model: 'gpt-4',
};

// Test: Validation result structure
const validation: ValidationResult = {
  valid: true,
  errors: [],
  warnings: [],
};

// If this file compiles, types are valid
console.log('✓ Type tests pass');
EOF
```

**Expected:** Test file created.

---

## Task 7: contracts Repo - Install and Build

**Files:**
- Modify: None (validation step)

**Step 1: Install dependencies**

Run from `contracts/` directory:
```bash
npm install
```

**Expected:** node_modules/ created, typescript installed.

**Step 2: Run build**

```bash
npm run build
```

**Expected:** dist/ directory created with compiled .js and .d.ts files. No errors.

**Step 3: Verify build output**

```bash
ls -la dist/
```

**Expected:** Should see index.js, index.d.ts, and all other compiled files.

---

## Task 8: contracts Repo - Initial Commit

**Files:**
- Commit all contracts/ files

**Step 1: Stage all files**

```bash
git add .
```

**Step 2: Commit**

```bash
git commit -m "feat: initialize @studio/contracts with type definitions

- Add all TypeScript interface definitions
- Add export barrel (index.ts)
- Add package.json, tsconfig.json, ARCHITECTURE.md
- Add placeholder type-level tests
- Verify build succeeds

Phase 1 foundation: Zero dependencies, pure types.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

**Step 3: Verify clean status**

```bash
git status
```

**Expected:** "nothing to commit, working tree clean"

**Step 4: Return to workspace root**

```bash
cd ..
```

---

## Task 9: ralph Repo - Directory Structure

**Files:**
- Create: `ralph/` directory
- Create: `ralph/src/` directory
- Create: `ralph/tests/` directory
- Create: `ralph/configs/examples/` directory

**Step 1: Create directories**

```bash
mkdir -p ralph/src ralph/tests ralph/configs/examples
cd ralph
```

**Step 2: Initialize git**

```bash
git init
git branch -m main
git config user.email "ariane.dguay@gmail.com"
git config user.name "Ariane Guay"
```

**Expected:** ralph/ repo initialized.

---

## Task 10: ralph Repo - Configuration Files

**Files:**
- Create: `ralph/.gitignore`
- Create: `ralph/package.json`
- Create: `ralph/tsconfig.json`

**Step 1: Create .gitignore**

```bash
cat > .gitignore << 'EOF'
node_modules/
dist/
*.log
.env
.DS_Store
EOF
```

**Step 2: Create package.json with contracts dependency**

```bash
cat > package.json << 'EOF'
{
  "name": "@studio/ralph",
  "version": "0.1.0",
  "description": "RALPH loop engine - Recursive Automated Loop for Persistent Handling",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "clean": "rm -rf dist",
    "typecheck": "tsc --noEmit"
  },
  "keywords": ["studio", "ralph", "retry", "validation"],
  "author": "Ariane Guay",
  "license": "ISC",
  "dependencies": {
    "@studio/contracts": "file:../contracts"
  },
  "devDependencies": {
    "typescript": "^5.3.0"
  }
}
EOF
```

**Step 3: Create tsconfig.json**

```bash
cat > tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
EOF
```

**Expected:** Config files created.

---

## Task 11: ralph Repo - ARCHITECTURE.md

**Files:**
- Create: `ralph/ARCHITECTURE.md`

**Step 1: Create ARCHITECTURE.md**

```bash
cat > ARCHITECTURE.md << 'EOF'
# @studio/ralph

RALPH loop engine — retry intelligent avec validation.
"Recursive Automated Loop for Persistent Handling" (Ralph Wiggum approved)

## Concept

ralph() prend un executor et un validator. Il execute, valide, retry si fail.
C'est tout. C'est générique. Ça marche pour n'importe quoi, pas juste des LLMs.

## Règles

- ralph() est UNE fonction. Pas une classe, pas un framework.
- La validation est composable (compose(...validators))
- Les stratégies de retry sont pluggables
- JAMAIS de dépendance sur runner ou engine — ralph est agnostique
- Dépend UNIQUEMENT de @studio/contracts

## Fichiers clés

- `loop.ts` — ralph() la fonction principale
- `validator.ts` — moteur de validation + composition
- `contracts.ts` — chargement output contracts YAML
- `retry-strategy.ts` — fixed, exponential, prompt escalation
- `context-enricher.ts` — enrichir contexte entre retries

## Anti-patterns

- NE PAS mettre de logique LLM ici
- NE PAS importer @studio/runner
- NE PAS hardcoder des règles de validation — tout vient des contracts YAML

## Usage

```typescript
import { ralph } from '@studio/ralph';

const result = await ralph({
  executor: () => doSomething(),
  validator: (result) => validate(result),
  maxAttempts: 3,
  retryStrategy: exponentialBackoff(1000, 10000),
});
```
EOF
```

**Expected:** ARCHITECTURE.md created.

---

## Task 12: ralph Repo - Placeholder Source Files

**Files:**
- Create: `ralph/src/index.ts`
- Create: `ralph/src/loop.ts`
- Create: `ralph/src/validator.ts`
- Create: `ralph/src/contracts.ts`
- Create: `ralph/src/retry-strategy.ts`
- Create: `ralph/src/context-enricher.ts`

**Step 1: Create src/index.ts**

```bash
cat > src/index.ts << 'EOF'
// Export barrel for @studio/ralph

export * from './loop.js';
export * from './validator.js';
export * from './contracts.js';
export * from './retry-strategy.js';
export * from './context-enricher.js';
EOF
```

**Step 2: Create src/loop.ts**

```bash
cat > src/loop.ts << 'EOF'
// RALPH loop - main function
import type { ValidationResult } from '@studio/contracts';

export interface RalphConfig<T> {
  executor: () => Promise<T>;
  validator: (result: T) => Promise<ValidationResult>;
  maxAttempts: number;
  retryStrategy: RetryStrategy;
  onRetry?: (attempt: number, lastResult: T, failures: string[]) => void;
}

export type RalphResult<T> =
  | { status: 'success'; result: T; attempts: number }
  | { status: 'exhausted'; lastResult: T; failures: string[]; attempts: number };

export interface RetryStrategy {
  getDelay(attempt: number): number;
}

export async function ralph<T>(config: RalphConfig<T>): Promise<RalphResult<T>> {
  // TODO: Implementation will go here
  throw new Error('Not implemented');
}
EOF
```

**Step 3: Create src/validator.ts**

```bash
cat > src/validator.ts << 'EOF'
// Validation engine
import type { ValidationResult, OutputContract } from '@studio/contracts';

export type Validator<T> = (result: T) => Promise<ValidationResult>;

export function validateOutput(output: unknown, contract: OutputContract): ValidationResult {
  // TODO: Implementation will go here
  return { valid: true, errors: [], warnings: [] };
}

export function validateToolCalls(toolCallsCount: number, requirements?: { minimum?: number }): ValidationResult {
  // TODO: Implementation will go here
  return { valid: true, errors: [], warnings: [] };
}

export function compose<T>(...validators: Validator<T>[]): Validator<T> {
  return async (result: T) => {
    // TODO: Implementation will go here
    return { valid: true, errors: [], warnings: [] };
  };
}
EOF
```

**Step 4: Create src/contracts.ts**

```bash
cat > src/contracts.ts << 'EOF'
// Load and parse output contracts from YAML
import type { OutputContract } from '@studio/contracts';

export async function loadContract(path: string): Promise<OutputContract> {
  // TODO: Implementation will go here
  throw new Error('Not implemented');
}

export function contractFromYaml(yaml: string): OutputContract {
  // TODO: Implementation will go here
  throw new Error('Not implemented');
}
EOF
```

**Step 5: Create src/retry-strategy.ts**

```bash
cat > src/retry-strategy.ts << 'EOF'
// Retry strategies
import type { RetryStrategy } from './loop.js';

export function fixedDelay(ms: number): RetryStrategy {
  return {
    getDelay: () => ms,
  };
}

export function exponentialBackoff(baseMs: number, maxMs: number): RetryStrategy {
  return {
    getDelay: (attempt: number) => {
      const delay = baseMs * Math.pow(2, attempt - 1);
      return Math.min(delay, maxMs);
    },
  };
}

export function withPromptEscalation(strategies: RetryStrategy[]): RetryStrategy {
  return {
    getDelay: (attempt: number) => {
      const index = Math.min(attempt - 1, strategies.length - 1);
      return strategies[index].getDelay(attempt);
    },
  };
}
EOF
```

**Step 6: Create src/context-enricher.ts**

```bash
cat > src/context-enricher.ts << 'EOF'
// Enrich context between retries

export interface EnrichedContext {
  previousAttempts: number;
  failures: string[];
  escalatedPrompt?: string;
}

export function addFailureContext<T>(
  prevResult: T,
  attempt: number,
  failures: string[]
): EnrichedContext {
  return {
    previousAttempts: attempt,
    failures,
  };
}

export function escalatePrompt(basePrompt: string, failures: string[]): string {
  if (failures.length === 0) {
    return basePrompt;
  }

  return `${basePrompt}

PREVIOUS ATTEMPTS FAILED:
${failures.map((f, i) => `${i + 1}. ${f}`).join('\n')}

Please address these issues in your next attempt.`;
}
EOF
```

**Expected:** All 6 source files created.

---

## Task 13: ralph Repo - Test Placeholders and YAML Examples

**Files:**
- Create: `ralph/tests/loop.test.ts`
- Create: `ralph/tests/validator.test.ts`
- Create: `ralph/tests/retry.test.ts`
- Create: `ralph/configs/examples/code-generation.contract.yaml`
- Create: `ralph/configs/examples/analysis.contract.yaml`

**Step 1: Create test placeholders**

```bash
cat > tests/loop.test.ts << 'EOF'
// Tests for RALPH loop
// TODO: Add Vitest tests when implementing
console.log('loop tests placeholder');
EOF

cat > tests/validator.test.ts << 'EOF'
// Tests for validator
// TODO: Add Vitest tests when implementing
console.log('validator tests placeholder');
EOF

cat > tests/retry.test.ts << 'EOF'
// Tests for retry strategies
// TODO: Add Vitest tests when implementing
console.log('retry strategy tests placeholder');
EOF
```

**Step 2: Create example YAML contracts**

```bash
cat > configs/examples/code-generation.contract.yaml << 'EOF'
name: code-generation
version: 1

schema:
  required_fields:
    - summary
    - files_changed
  files_changed:
    min_items: 1
    item_schema:
      required: [path, action, content]

tool_calls:
  minimum: 1
  required_tools:
    - repo_manager.write_file

custom_rules:
  - name: no-theatre
    description: "Agent must actually call tools, not just describe calling them"
    check: "tool_calls_count > 0 OR stage_kind != code_generation"
EOF

cat > configs/examples/analysis.contract.yaml << 'EOF'
name: analysis
version: 1

schema:
  required_fields:
    - summary
    - recommendations
  summary:
    min_length: 50
  recommendations:
    min_items: 1

tool_calls:
  minimum: 0  # Analysis doesn't require tool calls

custom_rules:
  - name: actionable-recommendations
    description: "Recommendations must be specific and actionable"
    check: "recommendations.length > 0"
EOF
```

**Expected:** Test placeholders and example YAMLs created.

---

## Task 14: ralph Repo - Install, Build, and Commit

**Files:**
- Validate and commit

**Step 1: Install dependencies**

```bash
npm install
```

**Expected:** node_modules/ created, contracts linked via file:.

**Step 2: Verify contracts dependency**

```bash
ls -la node_modules/@studio/contracts
```

**Expected:** Should be symlink to ../contracts.

**Step 3: Build**

```bash
npm run build
```

**Expected:** dist/ created, no errors.

**Step 4: Commit**

```bash
git add .
git commit -m "feat: initialize @studio/ralph with RALPH loop structure

- Add ralph() function signature and types
- Add validator engine with composition support
- Add retry strategies (fixed, exponential, escalation)
- Add context enricher for retry prompts
- Add contract loader (YAML parsing placeholder)
- Add example contracts (code-generation, analysis)
- Add test placeholders
- Depends on @studio/contracts via file:

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

**Step 5: Return to workspace root**

```bash
cd ..
```

---

## Task 15: runner Repo - Directory Structure

**Files:**
- Create: `runner/` directories

**Step 1: Create full directory structure**

```bash
mkdir -p runner/src/providers runner/src/tools/builtin runner/src/context runner/tests runner/configs/agents
cd runner
```

**Step 2: Initialize git**

```bash
git init
git branch -m main
git config user.email "ariane.dguay@gmail.com"
git config user.name "Ariane Guay"
```

**Expected:** runner/ repo initialized.

---

## Task 16: runner Repo - Configuration Files

**Files:**
- Create: `runner/.gitignore`
- Create: `runner/package.json`
- Create: `runner/tsconfig.json`

**Step 1: Create .gitignore**

```bash
cat > .gitignore << 'EOF'
node_modules/
dist/
*.log
.env
.DS_Store
EOF
```

**Step 2: Create package.json**

```bash
cat > package.json << 'EOF'
{
  "name": "@studio/runner",
  "version": "0.1.0",
  "description": "Multi-provider LLM agent runner with tool execution",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "clean": "rm -rf dist",
    "typecheck": "tsc --noEmit"
  },
  "keywords": ["studio", "runner", "agent", "llm"],
  "author": "Ariane Guay",
  "license": "ISC",
  "dependencies": {
    "@studio/contracts": "file:../contracts"
  },
  "devDependencies": {
    "typescript": "^5.3.0"
  }
}
EOF
```

**Step 3: Create tsconfig.json**

```bash
cat > tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
EOF
```

**Expected:** Config files created.

---

## Task 17: runner Repo - ARCHITECTURE.md and Source Files (1/2)

**Files:**
- Create: `runner/ARCHITECTURE.md`
- Create: `runner/src/index.ts`
- Create: `runner/src/runner.ts`
- Create: `runner/src/prompt-builder.ts`

**Step 1: Create ARCHITECTURE.md**

```bash
cat > ARCHITECTURE.md << 'EOF'
# @studio/runner

Agent runner multi-provider. Parle aux LLMs, exécute les tools.

## Concept

runAgent() prend un AgentConfig + context, appelle le LLM, exécute les tool calls,
retourne un AgentRun complet avec les vrais tool_calls trackés.

## Règles

- Multi-provider : OpenAI et Claude dès le start, même interface
- Les tools sont dans un registry pluggable
- CHAQUE tool call réel est tracké dans AgentRun.tool_calls
- Le runner ne valide PAS — c'est le job de ralph
- Le runner ne retry PAS — c'est le job de ralph
- Dépend UNIQUEMENT de @studio/contracts

## Fichiers clés

- `runner.ts` — runAgent() fonction principale
- `providers/` — OpenAI, Anthropic, registry
- `tools/` — tool executor, registry, builtins (repo_manager, shell, search)
- `prompt-builder.ts` — assemblage system prompt + context + task
- `context/` — construction du context window

## Anti-pattern critique : LE THÉÂTRE

Le problème #1 de la v6 : les agents génèrent du JSON décrivant des actions
au lieu de FAIRE les actions (tool_calls: 0). Le runner DOIT tracker les
tool calls réels. La validation du théâtre est dans ralph, mais le runner
fournit les données (tool_calls count) pour que ralph puisse détecter.
EOF
```

**Step 2: Create src/index.ts**

```bash
cat > src/index.ts << 'EOF'
// Export barrel for @studio/runner

export * from './runner.js';
export * from './prompt-builder.js';
export * from './providers/provider.js';
export * from './providers/registry.js';
export * from './tools/tool-executor.js';
export * from './tools/tool-registry.js';
export * from './context/context-pack.js';
EOF
```

**Step 3: Create src/runner.ts**

```bash
cat > src/runner.ts << 'EOF'
// Main runner function
import type { AgentConfig, AgentRun } from '@studio/contracts';

export interface RunAgentContext {
  input: string;
  previousOutputs?: unknown[];
  files?: string[];
}

export async function runAgent(
  config: AgentConfig,
  context: RunAgentContext
): Promise<AgentRun> {
  // TODO: Implementation
  // 1. Build prompt from config + context
  // 2. Call LLM provider
  // 3. Parse response and tool calls
  // 4. Execute tool calls
  // 5. Track everything in AgentRun

  throw new Error('Not implemented');
}
EOF
```

**Step 4: Create src/prompt-builder.ts**

```bash
cat > src/prompt-builder.ts << 'EOF'
// Assemble prompts from config and context
import type { AgentConfig, Message } from '@studio/contracts';
import type { RunAgentContext } from './runner.js';

export function buildPrompt(
  config: AgentConfig,
  context: RunAgentContext
): Message[] {
  const messages: Message[] = [];

  // System prompt
  if (config.system_prompt) {
    messages.push({
      role: 'system',
      content: config.system_prompt,
    });
  }

  // User input with context
  messages.push({
    role: 'user',
    content: context.input,
  });

  return messages;
}
EOF
```

**Expected:** ARCHITECTURE.md and first source files created.

---

## Task 18: runner Repo - Provider Files

**Files:**
- Create: `runner/src/providers/provider.ts`
- Create: `runner/src/providers/openai.ts`
- Create: `runner/src/providers/anthropic.ts`
- Create: `runner/src/providers/registry.ts`

**Step 1: Create providers/provider.ts**

```bash
cat > src/providers/provider.ts << 'EOF'
// Abstract provider interface
import type { LLMProvider } from '@studio/contracts';

export type { LLMProvider } from '@studio/contracts';

// Providers must implement the LLMProvider interface from contracts
EOF
```

**Step 2: Create providers/openai.ts**

```bash
cat > src/providers/openai.ts << 'EOF'
// OpenAI provider implementation
import type { LLMProvider, LLMRequest, LLMResponse } from '@studio/contracts';

export class OpenAIProvider implements LLMProvider {
  name = 'openai';

  async call(request: LLMRequest): Promise<LLMResponse> {
    // TODO: Implementation
    // Will call OpenAI API
    throw new Error('Not implemented');
  }
}
EOF
```

**Step 3: Create providers/anthropic.ts**

```bash
cat > src/providers/anthropic.ts << 'EOF'
// Anthropic (Claude) provider implementation
import type { LLMProvider, LLMRequest, LLMResponse } from '@studio/contracts';

export class AnthropicProvider implements LLMProvider {
  name = 'anthropic';

  async call(request: LLMRequest): Promise<LLMResponse> {
    // TODO: Implementation
    // Will call Anthropic API
    throw new Error('Not implemented');
  }
}
EOF
```

**Step 4: Create providers/registry.ts**

```bash
cat > src/providers/registry.ts << 'EOF'
// Provider registry
import type { LLMProvider } from '@studio/contracts';
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';

const providers = new Map<string, LLMProvider>();

// Register built-in providers
providers.set('openai', new OpenAIProvider());
providers.set('anthropic', new AnthropicProvider());

export function getProvider(name: string): LLMProvider {
  const provider = providers.get(name);
  if (!provider) {
    throw new Error(`Provider not found: ${name}`);
  }
  return provider;
}

export function registerProvider(provider: LLMProvider): void {
  providers.set(provider.name, provider);
}
EOF
```

**Expected:** All provider files created.

---

## Task 19: runner Repo - Tool Files

**Files:**
- Create: `runner/src/tools/tool-executor.ts`
- Create: `runner/src/tools/tool-registry.ts`
- Create: `runner/src/tools/builtin/repo-manager.ts`
- Create: `runner/src/tools/builtin/shell.ts`
- Create: `runner/src/tools/builtin/search.ts`

**Step 1: Create tools/tool-executor.ts**

```bash
cat > src/tools/tool-executor.ts << 'EOF'
// Execute tool calls
import type { ToolCall } from '@studio/contracts';

export interface ToolResult {
  success: boolean;
  output?: unknown;
  error?: string;
}

export async function executeTool(
  call: ToolCall,
  registry: ToolRegistry
): Promise<ToolResult> {
  // TODO: Implementation
  throw new Error('Not implemented');
}

export interface ToolRegistry {
  get(name: string): Tool | undefined;
  register(name: string, tool: Tool): void;
}

export interface Tool {
  name: string;
  description: string;
  execute(args: Record<string, unknown>): Promise<unknown>;
}
EOF
```

**Step 2: Create tools/tool-registry.ts**

```bash
cat > src/tools/tool-registry.ts << 'EOF'
// Tool registry
import type { Tool, ToolRegistry as IToolRegistry } from './tool-executor.js';

export class ToolRegistry implements IToolRegistry {
  private tools = new Map<string, Tool>();

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  register(name: string, tool: Tool): void {
    this.tools.set(name, tool);
  }

  list(): string[] {
    return Array.from(this.tools.keys());
  }
}

// Global registry instance
export const globalToolRegistry = new ToolRegistry();
EOF
```

**Step 3: Create builtin tools**

```bash
cat > src/tools/builtin/repo-manager.ts << 'EOF'
// Repository file management tools
import type { Tool } from '../tool-executor.js';

export const readFileTool: Tool = {
  name: 'repo_manager.read_file',
  description: 'Read contents of a file',
  async execute(args: Record<string, unknown>) {
    // TODO: Implementation
    throw new Error('Not implemented');
  },
};

export const writeFileTool: Tool = {
  name: 'repo_manager.write_file',
  description: 'Write content to a file',
  async execute(args: Record<string, unknown>) {
    // TODO: Implementation
    throw new Error('Not implemented');
  },
};

export const listFilesTool: Tool = {
  name: 'repo_manager.list_files',
  description: 'List files in a directory',
  async execute(args: Record<string, unknown>) {
    // TODO: Implementation
    throw new Error('Not implemented');
  },
};
EOF

cat > src/tools/builtin/shell.ts << 'EOF'
// Shell command execution (sandboxed)
import type { Tool } from '../tool-executor.js';

export const runCommandTool: Tool = {
  name: 'shell.run_command',
  description: 'Run a shell command (sandboxed)',
  async execute(args: Record<string, unknown>) {
    // TODO: Implementation with sandboxing
    throw new Error('Not implemented');
  },
};
EOF

cat > src/tools/builtin/search.ts << 'EOF'
// Codebase search tools
import type { Tool } from '../tool-executor.js';

export const searchCodebaseTool: Tool = {
  name: 'search.search_codebase',
  description: 'Search codebase with grep/ripgrep',
  async execute(args: Record<string, unknown>) {
    // TODO: Implementation
    throw new Error('Not implemented');
  },
};
EOF
```

**Expected:** All tool files created.

---

## Task 20: runner Repo - Context Files, Tests, Configs

**Files:**
- Create: `runner/src/context/context-pack.ts`
- Create: `runner/src/context/context-sources.ts`
- Create: Test placeholders
- Create: Agent YAML configs

**Step 1: Create context files**

```bash
cat > src/context/context-pack.ts << 'EOF'
// Construct context window
export interface ContextPack {
  input: string;
  previousOutputs: unknown[];
  files: string[];
}

export function packContext(sources: unknown[]): ContextPack {
  // TODO: Implementation
  return {
    input: '',
    previousOutputs: [],
    files: [],
  };
}
EOF

cat > src/context/context-sources.ts << 'EOF'
// Context source loaders
export async function loadFileContext(path: string): Promise<string> {
  // TODO: Implementation
  throw new Error('Not implemented');
}

export async function loadPreviousOutputs(stageId: string): Promise<unknown[]> {
  // TODO: Implementation
  return [];
}
EOF
```

**Step 2: Create test placeholders**

```bash
cat > tests/runner.test.ts << 'EOF'
// Runner tests placeholder
console.log('runner tests');
EOF

cat > tests/openai.test.ts << 'EOF'
// OpenAI integration tests placeholder
console.log('openai tests');
EOF

cat > tests/anthropic.test.ts << 'EOF'
// Anthropic integration tests placeholder
console.log('anthropic tests');
EOF

cat > tests/tool-executor.test.ts << 'EOF'
// Tool executor tests placeholder
console.log('tool executor tests');
EOF

cat > tests/prompt-builder.test.ts << 'EOF'
// Prompt builder tests placeholder
console.log('prompt builder tests');
EOF
```

**Step 3: Create agent configs**

```bash
cat > configs/agents/generic.agent.yaml << 'EOF'
name: generic
description: Generic agent for any task
provider: anthropic
model: claude-sonnet-4-20250514

system_prompt: |
  You are a helpful AI agent.

tools:
  - repo_manager.read_file
  - repo_manager.write_file
  - repo_manager.list_files
  - shell.run_command
  - search.search_codebase

temperature: 0.3
max_tokens: 8000
EOF

cat > configs/agents/code-generator.agent.yaml << 'EOF'
name: code-generator
description: Generates and writes code to the repository
provider: anthropic
model: claude-sonnet-4-20250514

system_prompt: |
  You are a code generation agent. Your job is to write code to files.

  CRITICAL RULES:
  - You MUST use tool calls to write files. Do NOT describe what you would write.
  - Every file change MUST go through repo_manager.write_file
  - If you output files_changed without calling write_file, you have FAILED.
  - tool_calls = 0 on a code generation task is ALWAYS a failure.

tools:
  - repo_manager.read_file
  - repo_manager.write_file
  - repo_manager.list_files
  - shell.run_command
  - search.search_codebase

temperature: 0.2
max_tokens: 8000
EOF

cat > configs/agents/analyst.agent.yaml << 'EOF'
name: analyst
description: Analyzes code and provides recommendations
provider: anthropic
model: claude-sonnet-4-20250514

system_prompt: |
  You are a code analysis agent. Your job is to analyze code and provide insights.

tools:
  - repo_manager.read_file
  - repo_manager.list_files
  - search.search_codebase

temperature: 0.3
max_tokens: 8000
EOF
```

**Expected:** Context files, tests, and configs created.

---

## Task 21: runner Repo - Install, Build, Commit

**Files:**
- Validate and commit

**Step 1: Install and verify**

```bash
npm install
ls -la node_modules/@studio/contracts
```

**Expected:** contracts dependency linked.

**Step 2: Build**

```bash
npm run build
```

**Expected:** Successful build.

**Step 3: Commit**

```bash
git add .
git commit -m "feat: initialize @studio/runner with multi-provider structure

- Add runAgent() main function
- Add multi-provider support (OpenAI, Anthropic)
- Add tool execution framework with registry
- Add builtin tools (repo_manager, shell, search)
- Add prompt builder
- Add context packing
- Add agent profile configs (generic, code-generator, analyst)
- Add test placeholders
- Depends on @studio/contracts

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"

cd ..
```

---

## Task 22: engine Repo - Setup

Due to complexity, engine setup is broken into multiple tasks.

**Files:**
- Create directories

**Step 1: Create structure**

```bash
mkdir -p engine/src/state engine/src/pipeline engine/src/db engine/tests/e2e engine/prisma engine/pipelines
cd engine
```

**Step 2: Initialize git**

```bash
git init
git branch -m main
git config user.email "ariane.dguay@gmail.com"
git config user.name "Ariane Guay"
```

---

## Task 23: engine Repo - Config Files

**Files:**
- Create: `engine/.gitignore`
- Create: `engine/package.json`
- Create: `engine/tsconfig.json`

**Step 1: Create .gitignore**

```bash
cat > .gitignore << 'EOF'
node_modules/
dist/
*.log
.env
.DS_Store
*.db
*.db-journal
EOF
```

**Step 2: Create package.json**

```bash
cat > package.json << 'EOF'
{
  "name": "@studio/engine",
  "version": "0.1.0",
  "description": "Pipeline orchestration engine for Studio v7",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "clean": "rm -rf dist",
    "typecheck": "tsc --noEmit"
  },
  "keywords": ["studio", "engine", "pipeline", "orchestration"],
  "author": "Ariane Guay",
  "license": "ISC",
  "dependencies": {
    "@studio/contracts": "file:../contracts",
    "@studio/ralph": "file:../ralph",
    "@studio/runner": "file:../runner",
    "prisma": "^5.0.0",
    "@prisma/client": "^5.0.0"
  },
  "devDependencies": {
    "typescript": "^5.3.0"
  }
}
EOF
```

**Step 3: Create tsconfig.json**

```bash
cat > tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
EOF
```

---

## Task 24: engine Repo - ARCHITECTURE.md and Core Files

**Files:**
- Create: `engine/ARCHITECTURE.md`
- Create: `engine/src/index.ts`
- Create: `engine/src/engine.ts`
- Create: `engine/src/events.ts`

**Step 1: Create ARCHITECTURE.md**

```bash
cat > ARCHITECTURE.md << 'EOF'
# @studio/engine

Orchestrateur de pipelines. Le cerveau de Studio.

## Concept

Charge une pipeline YAML → exécute les stages en séquence →
pour chaque task: ralph(runner.run, validator) → persiste les runs en SQLite.

## Règles

- UN pipeline = séquence de stages (pas de DAG pour la v7, KISS)
- deriveStageStatusFromTasks() est LA fonction critique — elle doit être
  déterministe et testée exhaustivement
- La DB (SQLite) est UNIQUEMENT dans ce repo
- Context propagation : output stage N → input stage N+1
- Events (onStageStart, etc.) pour hooks futurs (UI, logging)

## Fichiers clés

- `engine.ts` — PipelineEngine, la classe principale
- `state/state-machine.ts` — lifecycle des stages
- `state/status-derivation.ts` — deriveStageStatusFromTasks() ← CRITIQUE
- `state/run-store.ts` — persistence SQLite via Prisma
- `pipeline/loader.ts` — charge YAML → PipelineDefinition
- `pipeline/context-propagation.ts` — passe le contexte entre stages

## Le test qui compte

tests/e2e/feature-v5.test.ts — FAQ sur About.tsx, doit passer 10/10.
Si ce test passe pas de façon fiable, rien d'autre compte.

## Dépendances

@studio/contracts, @studio/ralph, @studio/runner
EOF
```

**Step 2: Create source files**

```bash
cat > src/index.ts << 'EOF'
// Export barrel for @studio/engine

export * from './engine.js';
export * from './events.js';
export * from './state/state-machine.js';
export * from './state/status-derivation.js';
export * from './pipeline/loader.js';
export * from './pipeline/context-propagation.js';
EOF

cat > src/engine.ts << 'EOF'
// Main pipeline engine
import type { PipelineDefinition, PipelineRun } from '@studio/contracts';

export class PipelineEngine {
  async loadPipeline(path: string): Promise<PipelineDefinition> {
    // TODO: Implementation
    throw new Error('Not implemented');
  }

  async run(pipeline: PipelineDefinition, input: string): Promise<PipelineRun> {
    // TODO: Implementation
    // For each stage:
    //   1. Resolve tasks
    //   2. For each task: ralph(runner.run, validator)
    //   3. deriveStageStatus(tasks)
    //   4. Propagate context to next stage
    throw new Error('Not implemented');
  }
}
EOF

cat > src/events.ts << 'EOF'
// Event emitter for pipeline events
export type PipelineEvent =
  | { type: 'pipeline_start'; pipelineId: string }
  | { type: 'pipeline_complete'; pipelineId: string }
  | { type: 'stage_start'; stageId: string }
  | { type: 'stage_complete'; stageId: string }
  | { type: 'task_start'; taskId: string }
  | { type: 'task_complete'; taskId: string };

export class PipelineEventEmitter {
  private listeners: Array<(event: PipelineEvent) => void> = [];

  on(listener: (event: PipelineEvent) => void): void {
    this.listeners.push(listener);
  }

  emit(event: PipelineEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
EOF
```

---

## Task 25: engine Repo - State Files

**Files:**
- Create: `engine/src/state/state-machine.ts`
- Create: `engine/src/state/status-derivation.ts`
- Create: `engine/src/state/run-store.ts`

**Step 1: Create state files**

```bash
cat > src/state/state-machine.ts << 'EOF'
// Stage lifecycle state machine
import type { StageStatus } from '@studio/contracts';

export type StateTransition = {
  from: StageStatus;
  to: StageStatus;
  condition?: string;
};

export const validTransitions: StateTransition[] = [
  { from: 'pending', to: 'running' },
  { from: 'running', to: 'success' },
  { from: 'running', to: 'failed' },
  { from: 'running', to: 'skipped' },
];

export function canTransition(from: StageStatus, to: StageStatus): boolean {
  return validTransitions.some(t => t.from === from && t.to === to);
}
EOF

cat > src/state/status-derivation.ts << 'EOF'
// Derive stage status from task statuses
// THIS IS THE CRITICAL FUNCTION
import type { StageStatus, TaskStatus } from '@studio/contracts';

export function deriveStageStatusFromTasks(taskStatuses: TaskStatus[]): StageStatus {
  if (taskStatuses.length === 0) {
    return 'pending';
  }

  // If any task is running, stage is running
  if (taskStatuses.some(s => s === 'running')) {
    return 'running';
  }

  // If any task failed, stage failed
  if (taskStatuses.some(s => s === 'failed')) {
    return 'failed';
  }

  // If all tasks succeeded, stage succeeded
  if (taskStatuses.every(s => s === 'success')) {
    return 'success';
  }

  // If any task is pending, stage is still pending
  if (taskStatuses.some(s => s === 'pending')) {
    return 'pending';
  }

  // Default to pending
  return 'pending';
}
EOF

cat > src/state/run-store.ts << 'EOF'
// Persistence layer for runs (SQLite via Prisma)
import type { PipelineRun, StageRun, TaskRun } from '@studio/contracts';

export class RunStore {
  async savePipelineRun(run: PipelineRun): Promise<void> {
    // TODO: Implementation with Prisma
    throw new Error('Not implemented');
  }

  async getPipelineRun(id: string): Promise<PipelineRun | null> {
    // TODO: Implementation
    throw new Error('Not implemented');
  }

  async listRuns(): Promise<PipelineRun[]> {
    // TODO: Implementation
    return [];
  }
}
EOF
```

---

## Task 26: engine Repo - Pipeline Files

**Files:**
- Create: `engine/src/pipeline/loader.ts`
- Create: `engine/src/pipeline/stage-resolver.ts`
- Create: `engine/src/pipeline/context-propagation.ts`

**Step 1: Create pipeline files**

```bash
cat > src/pipeline/loader.ts << 'EOF'
// Load pipeline from YAML
import type { PipelineDefinition } from '@studio/contracts';

export async function loadPipeline(path: string): Promise<PipelineDefinition> {
  // TODO: Implementation - read YAML, parse, validate
  throw new Error('Not implemented');
}

export function parsePipelineYaml(yaml: string): PipelineDefinition {
  // TODO: Implementation
  throw new Error('Not implemented');
}
EOF

cat > src/pipeline/stage-resolver.ts << 'EOF'
// Resolve stages (sequential for v7)
import type { StageDefinition } from '@studio/contracts';

export function resolveStages(stages: StageDefinition[]): StageDefinition[] {
  // For v7: just return stages in order (sequential execution)
  // Future: could support DAG, parallel stages
  return stages;
}
EOF

cat > src/pipeline/context-propagation.ts << 'EOF'
// Propagate context between stages
export interface StageContext {
  input: string;
  previousOutputs: unknown[];
}

export function propagateContext(
  previousOutput: unknown,
  baseInput: string
): StageContext {
  return {
    input: baseInput,
    previousOutputs: previousOutput ? [previousOutput] : [],
  };
}
EOF
```

---

## Task 27: engine Repo - DB and Pipeline Files

**Files:**
- Create: `engine/src/db/client.ts`
- Create: `engine/prisma/schema.prisma`
- Create: `engine/pipelines/feature-builder.pipeline.yaml`

**Step 1: Create DB client**

```bash
mkdir -p src/db
cat > src/db/client.ts << 'EOF'
// Prisma client for SQLite
// TODO: Will use @prisma/client after schema is set up
export const db = null; // Placeholder
EOF
```

**Step 2: Create Prisma schema placeholder**

```bash
cat > prisma/schema.prisma << 'EOF'
// Prisma schema for Studio v7 engine
// SQLite for simplicity

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = "file:./studio.db"
}

// TODO: Define models for PipelineRun, StageRun, TaskRun, AgentRun
// This will be implemented during Phase 4
EOF
```

**Step 3: Create example pipeline**

```bash
cat > pipelines/feature-builder.pipeline.yaml << 'EOF'
name: feature-builder
description: Build a feature from A to Z
version: 1

stages:
  - name: brief-analysis
    kind: analysis
    agent: analyst
    contract: analysis.contract.yaml
    ralph:
      max_attempts: 3
      retry_strategy: exponential
    context:
      include:
        - input
        - repo_structure

  - name: architecture
    kind: planning
    agent: analyst
    contract: architecture.contract.yaml
    ralph:
      max_attempts: 3
    context:
      include:
        - input
        - previous_stage_output

  - name: code-generation
    kind: code_generation
    agent: code-generator
    contract: code-generation.contract.yaml
    ralph:
      max_attempts: 5
      retry_strategy: prompt_escalation
    tools:
      required:
        - repo_manager.write_file
    context:
      include:
        - input
        - previous_stage_output
        - repo_files

  - name: qa-validation
    kind: qa
    agent: analyst
    contract: qa.contract.yaml
    ralph:
      max_attempts: 3
    context:
      include:
        - input
        - all_stage_outputs
EOF
```

---

## Task 28: engine Repo - Tests and Commit

**Files:**
- Create test placeholders
- Install, build, commit

**Step 1: Create test placeholders**

```bash
cat > tests/engine.test.ts << 'EOF'
// Engine E2E tests placeholder
console.log('engine tests');
EOF

cat > tests/state-machine.test.ts << 'EOF'
// State machine tests placeholder
console.log('state machine tests');
EOF

cat > tests/status-derivation.test.ts << 'EOF'
// Status derivation tests placeholder
// THIS IS THE CRITICAL TEST
console.log('status derivation tests');
EOF

cat > tests/loader.test.ts << 'EOF'
// Pipeline loader tests placeholder
console.log('loader tests');
EOF

mkdir -p tests/e2e
cat > tests/e2e/feature-v5.test.ts << 'EOF'
// Feature v5 E2E test
// "Add FAQ to About.tsx" - must pass 10/10
console.log('feature v5 e2e test');
EOF
```

**Step 2: Install and build**

```bash
npm install
npm run build
```

**Expected:** All dependencies linked, build succeeds.

**Step 3: Commit**

```bash
git add .
git commit -m "feat: initialize @studio/engine with orchestration structure

- Add PipelineEngine class
- Add state machine for stage lifecycle
- Add critical deriveStageStatusFromTasks() function
- Add run persistence with Prisma (SQLite)
- Add pipeline loader (YAML parsing)
- Add stage resolver and context propagation
- Add event emitter for hooks
- Add example feature-builder pipeline
- Add Prisma schema placeholder
- Add test placeholders including critical E2E test
- Depends on @studio/contracts, @studio/ralph, @studio/runner

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"

cd ..
```

---

## Task 29: cli Repo - Setup

**Files:**
- Create directories

**Step 1: Create structure**

```bash
mkdir -p cli/src/commands cli/src/output cli/tests/commands cli/templates/pipelines
cd cli
```

**Step 2: Initialize git**

```bash
git init
git branch -m main
git config user.email "ariane.dguay@gmail.com"
git config user.name "Ariane Guay"
```

---

## Task 30: cli Repo - Config Files

**Files:**
- Create: `cli/.gitignore`
- Create: `cli/package.json`
- Create: `cli/tsconfig.json`

**Step 1: Create .gitignore**

```bash
cat > .gitignore << 'EOF'
node_modules/
dist/
*.log
.env
.DS_Store
EOF
```

**Step 2: Create package.json with bin**

```bash
cat > package.json << 'EOF'
{
  "name": "@studio/cli",
  "version": "0.1.0",
  "description": "Command-line interface for Studio v7",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": {
    "studio": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "clean": "rm -rf dist",
    "typecheck": "tsc --noEmit"
  },
  "keywords": ["studio", "cli"],
  "author": "Ariane Guay",
  "license": "ISC",
  "dependencies": {
    "@studio/contracts": "file:../contracts",
    "@studio/engine": "file:../engine"
  },
  "devDependencies": {
    "typescript": "^5.3.0"
  }
}
EOF
```

**Step 3: Create tsconfig.json**

```bash
cat > tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
EOF
```

---

## Task 31: cli Repo - ARCHITECTURE.md and Core Files

**Files:**
- Create: `cli/ARCHITECTURE.md`
- Create: `cli/src/index.ts`
- Create: `cli/src/config.ts`

**Step 1: Create ARCHITECTURE.md**

```bash
cat > ARCHITECTURE.md << 'EOF'
# @studio/cli

Interface terminal pour Studio. Thin wrapper sur engine.

## Règles

- ZERO logique métier — tout est dans engine
- Pretty output pour humains, JSON pour machines (--json flag)
- Commandes simples et évidentes
- Dépend de @studio/contracts et @studio/engine (PAS de ralph/runner direct)

## Fichiers clés

- `commands/run.ts` — studio run <pipeline> [--input "..."]
- `commands/validate.ts` — studio validate <contract> <output>
- `commands/list.ts` — studio list pipelines|agents|runs
- `commands/status.ts` — studio status [run-id]
- `commands/init.ts` — studio init (setup nouveau projet)
- `output/` — formatter, logger, progress bar

## Usage

```bash
$ studio run feature-builder --input "Add FAQ to About page"
$ studio status last
$ studio list runs --failed
```
EOF
```

**Step 2: Create src/index.ts**

```bash
cat > src/index.ts << 'EOF'
#!/usr/bin/env node
// Main CLI entry point

console.log('Studio v7 CLI');
console.log('TODO: Implement command parsing and dispatch');
process.exit(0);
EOF

chmod +x src/index.ts
```

**Step 3: Create src/config.ts**

```bash
cat > src/config.ts << 'EOF'
// Load .studiorc.yaml configuration

export interface StudioConfig {
  providers: Record<string, { apiKey: string }>;
  paths: {
    pipelines: string;
    contracts: string;
    agents: string;
  };
}

export function loadConfig(path?: string): StudioConfig {
  // TODO: Implementation - load YAML config
  return {
    providers: {},
    paths: {
      pipelines: './pipelines',
      contracts: './contracts',
      agents: './agents',
    },
  };
}
EOF
```

---

## Task 32: cli Repo - Command Files

**Files:**
- Create: `cli/src/commands/run.ts`
- Create: `cli/src/commands/validate.ts`
- Create: `cli/src/commands/list.ts`
- Create: `cli/src/commands/status.ts`
- Create: `cli/src/commands/init.ts`

**Step 1: Create command files**

```bash
cat > src/commands/run.ts << 'EOF'
// studio run <pipeline> [--input "..."]
export async function runCommand(pipelineName: string, input?: string): Promise<void> {
  console.log(`Running pipeline: ${pipelineName}`);
  console.log(`Input: ${input}`);
  // TODO: Call engine.run()
}
EOF

cat > src/commands/validate.ts << 'EOF'
// studio validate <contract> <output>
export async function validateCommand(contractPath: string, outputPath: string): Promise<void> {
  console.log(`Validating ${outputPath} against ${contractPath}`);
  // TODO: Load contract, validate output
}
EOF

cat > src/commands/list.ts << 'EOF'
// studio list pipelines|agents|runs
export async function listCommand(resource: string): Promise<void> {
  console.log(`Listing ${resource}...`);
  // TODO: Query engine for resource list
}
EOF

cat > src/commands/status.ts << 'EOF'
// studio status [run-id]
export async function statusCommand(runId?: string): Promise<void> {
  console.log(`Status for run: ${runId || 'last'}`);
  // TODO: Query engine for run status
}
EOF

cat > src/commands/init.ts << 'EOF'
// studio init - setup new project
export async function initCommand(): Promise<void> {
  console.log('Initializing Studio project...');
  // TODO: Create .studiorc.yaml, pipelines/, agents/, contracts/
}
EOF
```

---

## Task 33: cli Repo - Output Files

**Files:**
- Create: `cli/src/output/formatter.ts`
- Create: `cli/src/output/logger.ts`
- Create: `cli/src/output/progress.ts`

**Step 1: Create output files**

```bash
cat > src/output/formatter.ts << 'EOF'
// Pretty print for terminal
import type { PipelineRun } from '@studio/contracts';

export function formatPipelineRun(run: PipelineRun): string {
  // TODO: Pretty format with colors
  return `Pipeline: ${run.pipeline_name}\nStatus: ${run.status}`;
}

export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}
EOF

cat > src/output/logger.ts << 'EOF'
// Structured logging
export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export function log(level: LogLevel, message: string, data?: unknown): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${level.toUpperCase()}: ${message}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
}
EOF

cat > src/output/progress.ts << 'EOF'
// Progress bar / stage tracker
export class ProgressTracker {
  private current = 0;
  private total = 0;

  constructor(total: number) {
    this.total = total;
  }

  update(stage: string): void {
    this.current++;
    console.log(`[${this.current}/${this.total}] ${stage} ...`);
  }

  complete(): void {
    console.log('✓ Complete');
  }
}
EOF
```

---

## Task 34: cli Repo - Templates, Tests, and Commit

**Files:**
- Create template files
- Create test placeholders
- Install, build, commit

**Step 1: Create templates**

```bash
cat > templates/.studiorc.yaml << 'EOF'
# Studio v7 Configuration

providers:
  openai:
    apiKey: ${OPENAI_API_KEY}
  anthropic:
    apiKey: ${ANTHROPIC_API_KEY}

paths:
  pipelines: ./pipelines
  contracts: ./contracts
  agents: ./agents

defaults:
  provider: anthropic
  model: claude-sonnet-4-20250514
EOF

cat > templates/pipelines/hello-world.pipeline.yaml << 'EOF'
name: hello-world
description: Simple hello world pipeline
version: 1

stages:
  - name: greet
    kind: custom
    agent: generic
    ralph:
      max_attempts: 1
    context:
      include:
        - input
EOF
```

**Step 2: Create test placeholders**

```bash
cat > tests/commands/run.test.ts << 'EOF'
// Run command tests placeholder
console.log('run command tests');
EOF

cat > tests/commands/status.test.ts << 'EOF'
// Status command tests placeholder
console.log('status command tests');
EOF
```

**Step 3: Install and build**

```bash
npm install
npm run build
```

**Expected:** Build succeeds.

**Step 4: Commit**

```bash
git add .
git commit -m "feat: initialize @studio/cli with command structure

- Add CLI entry point with shebang
- Add command files (run, validate, list, status, init)
- Add output formatting (formatter, logger, progress)
- Add config loader for .studiorc.yaml
- Add template files (.studiorc.yaml, hello-world pipeline)
- Add test placeholders
- Add bin config for 'studio' command
- Depends on @studio/contracts, @studio/engine

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"

cd ..
```

---

## Task 35: Final Validation

**Files:**
- Validate entire workspace

**Step 1: Verify all repos exist**

```bash
ls -la
```

**Expected:** See contracts/, ralph/, runner/, engine/, cli/ directories.

**Step 2: Build all repos**

From workspace root:
```bash
cd contracts && npm run build && cd ..
cd ralph && npm run build && cd ..
cd runner && npm run build && cd ..
cd engine && npm run build && cd ..
cd cli && npm run build && cd ..
```

**Expected:** All builds succeed with no errors.

**Step 3: Verify dependency chain**

```bash
# Check cli depends on engine
cat cli/package.json | grep "@studio/engine"

# Check engine depends on contracts, ralph, runner
cat engine/package.json | grep "@studio"

# Check ralph and runner depend on contracts
cat ralph/package.json | grep "@studio/contracts"
cat runner/package.json | grep "@studio/contracts"

# Check contracts has no dependencies
cat contracts/package.json | grep "\"dependencies\""
```

**Expected:** Dependencies as specified in design.

**Step 4: Check all ARCHITECTURE.md files**

```bash
ls -la contracts/ARCHITECTURE.md
ls -la ralph/ARCHITECTURE.md
ls -la runner/ARCHITECTURE.md
ls -la engine/ARCHITECTURE.md
ls -la cli/ARCHITECTURE.md
```

**Expected:** All exist.

**Step 5: Verify git status**

```bash
cd contracts && git status && cd ..
cd ralph && git status && cd ..
cd runner && git status && cd ..
cd engine && git status && cd ..
cd cli && git status && cd ..
```

**Expected:** All repos have clean working trees.

---

## Task 36: Commit Parent Workspace Architecture Doc

**Files:**
- Commit existing architecture doc to parent

**Step 1: Add architecture doc to parent git**

From workspace root:
```bash
git add docs/architecture/architecture-studio-v7.md
git commit -m "docs: add Studio v7 architecture document

Complete architecture specification for the v7 rewrite.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

**Expected:** Architecture doc committed to parent repo.

---

## Success Criteria Checklist

After completing all tasks, verify:

- ✅ All 6 repos exist (workspace + 5 sub-repos)
- ✅ Each sub-repo is a git repository
- ✅ Each sub-repo has package.json, tsconfig.json, ARCHITECTURE.md, .gitignore
- ✅ All repos build successfully
- ✅ Dependencies resolve via file: paths
- ✅ Parent workspace has build:all script
- ✅ setup.sh script exists and is executable
- ✅ Test directories exist with placeholders
- ✅ All repos have clean git status

---

## Next Steps

After setup completion:

1. **Start Phase 1:** Implement @studio/contracts fully
   - Replace placeholder types with complete definitions
   - Add comprehensive type-level tests
   - Validate against architecture doc

2. **Then Phase 2:** Implement @studio/ralph
   - Build the RALPH loop
   - Add validation engine
   - Write unit tests

3. **Continue through phases** until `studio run feature-builder` works reliably

---

## References

- Design document: `docs/plans/2026-02-13-studio-v7-workspace-setup-design.md`
- Architecture: `docs/architecture/architecture-studio-v7.md`
- Final goal: 10/10 success rate on feature-builder pipeline
