# TEMPLATES.md — Studio Templates System

Templates are **architectural patterns** that generate complete application starters for different types of AI-powered work.

## Core Concept

**Templates are NOT finished products.** They are rich, functional starting points that you customize into your own product.

Think `create-react-app` or `create-next-app`, but for AI pipeline orchestration.

```bash
studio init --template software --name code-builder
# → Generates a complete app with pipelines, tools, DB schema, code structure
# → Ready to run immediately
# → Customize for your specific use case
```

## Philosophy

### Why templates?

Studio is domain-agnostic. The kernel doesn't know what "code" or "transactions" or "entities" mean. All domain knowledge comes from configurations.

But creating all those configurations from scratch for each project would be tedious and error-prone.

**Templates solve this:** They package proven patterns for common types of work.

### Rich starters, not minimal boilerplate

Templates generate **working applications**, not empty scaffolds.

After `studio init --template software`:
- Pipelines work out-of-the-box
- Tools are configured and functional
- Database schema is ready
- Code structure exists
- You can immediately run `studio run software/feature-builder`

Then you customize: add your own pipelines, extend the schema, build your UI.

---

## Official Templates

### `software` — Code generation and modification

**Use cases:**
- Code generators
- Feature builders
- Bug fixers
- Refactoring tools
- Git history cleaners
- API scaffolders

**Included pipelines:**
- `feature-builder` — Generate new features from descriptions
- `bug-fixer` — Analyze and fix bugs
- `refactor` — Restructure code while preserving behavior

**Included tools:**
- `repo_manager-read_file`
- `repo_manager-write_file`
- `repo_manager-list_files`
- `shell-run_command`
- `search-search_codebase`

**Contracts include:**
- Anti-theatre validation (must actually write files)
- Required tool calls enforcement
- Code quality checks via QA stages

**DB schema starter:**
```prisma
model Repo {
  id          String   @id @default(uuid())
  path        String
  branch      String
  lastSync    DateTime
}

model Feature {
  id          String   @id @default(uuid())
  repoId      String
  description String
  status      String
  createdAt   DateTime @default(now())
}
```

**Example products:**
- Code Builder — Full IDE integration for feature generation
- Git Butler — Clean messy git history automatically
- API Generator — Generate REST APIs from descriptions

---

### `finance` — Transaction analysis and budget management

**Use cases:**
- Personal finance managers
- Expense trackers
- Budget planners
- Invoicing tools
- Portfolio managers
- Automated savings

**Included pipelines:**
- `transaction-analysis` — Categorize and analyze transactions
- `budget-planning` — Generate budget recommendations
- `account-splitting` — Auto-split income across accounts

**Included tools:**
- `bank-api` (integration with Plaid or similar)
- `categorization` (ML-based transaction categorization)
- `budget-calculator`
- `notification-sender`

**Contracts include:**
- Transaction validation (amount, date, merchant)
- Budget constraint checking
- Compliance with financial rules

**DB schema starter:**
```prisma
model User {
  id        String   @id @default(uuid())
  email     String   @unique
  accounts  Account[]
}

model Account {
  id            String   @id @default(uuid())
  userId        String
  plaidId       String
  balance       Float
  transactions  Transaction[]
}

model Transaction {
  id          String   @id @default(uuid())
  accountId   String
  amount      Float
  merchant    String
  category    String
  date        DateTime
}

model Budget {
  id          String   @id @default(uuid())
  userId      String
  category    String
  amount      Float
  period      String   // monthly, weekly
}
```

**Example products:**
- ADHD Finance — Specialized for neurodivergent money management
- Freelance Invoicing — Auto-generate invoices from time tracking
- Crypto Portfolio Manager — Track and rebalance crypto holdings

---

### `analysis` — Content extraction and structuring

**Use cases:**
- Document analyzers
- Entity extractors
- Text structurers
- Content parsers
- Voice analyzers
- Legal document processors
- Medical report parsers

**Included pipelines:**
- `content-extraction` — Extract structured content from unstructured input
- `entity-recognition` — Identify and classify entities
- `structure-generation` — Generate hierarchical structures

**Included tools:**
- `text-processor` (parsing, tokenization, NLP)
- `entity-extractor`
- `relationship-mapper`
- `schema-validator`

**Contracts include:**
- Required entity types detected
- Minimum confidence thresholds
- Structure completeness validation

**DB schema starter:**
```prisma
model Analysis {
  id          String   @id @default(uuid())
  input       String
  status      String
  result      Json
  entities    Entity[]
  createdAt   DateTime @default(now())
}

model Entity {
  id            String   @id @default(uuid())
  analysisId    String
  type          String
  name          String
  confidence    Float
  relationships Relationship[]
}

model Relationship {
  id          String   @id @default(uuid())
  fromId      String
  toId        String
  type        String
}
```

**Example products:**
- Wiki Creator — Convert books into structured wikis
- Voice Training — Analyze voice recordings for feminization training
- Legal Analyzer — Extract clauses and risks from contracts
- Medical Parser — Structure medical reports for compliance

**Note:** Very versatile template. The same pattern works for text, audio, video, or any content that needs analysis and structuring.

---

### `data` — Validation, transformation, and compliance

**Use cases:**
- Data validators
- ETL pipeline auditors
- Schema migrators
- Compliance checkers
- Data cleaners
- CSV/Excel processors

**Included pipelines:**
- `schema-validation` — Validate data against schemas
- `transformation` — Transform data between formats
- `compliance-check` — Check regulatory compliance

**Included tools:**
- `schema-validator`
- `data-transformer`
- `compliance-rules`
- `audit-logger`

**Contracts include:**
- Schema conformance validation
- Regulatory rule checking
- Data integrity constraints

**DB schema starter:**
```prisma
model ValidationRun {
  id          String   @id @default(uuid())
  datasetId   String
  schema      Json
  status      String
  errors      ValidationError[]
  createdAt   DateTime @default(now())
}

model ValidationError {
  id          String   @id @default(uuid())
  runId       String
  field       String
  rule        String
  message     String
  severity    String
}

model ComplianceCheck {
  id          String   @id @default(uuid())
  type        String   // GDPR, HIPAA, SOC2, etc.
  status      String
  findings    Json
}
```

**Example products:**
- GrayOS Compliance Validator — Medical data HIPAA/GDPR validation
- ETL Auditor — Validate data transformations in pipelines
- CSV Cleaner — Clean and normalize messy CSV files
- Schema Migrator — Migrate data between database schemas

---

### `conversation` — Dialogue management and memory

**Use cases:**
- Chatbots
- Virtual assistants
- Therapy tools
- Learning assistants
- Customer support bots

**Included pipelines:**
- `dialogue-management` — Handle multi-turn conversations
- `memory-storage` — Store and retrieve conversation context
- `intent-classification` — Classify user intents
- `response-generation` — Generate contextual responses

**Included tools:**
- `memory-store`
- `intent-classifier`
- `context-retriever`
- `response-generator`

**Contracts include:**
- Intent classification confidence
- Response relevance validation
- Memory consistency checks

**DB schema starter:**
```prisma
model Conversation {
  id          String   @id @default(uuid())
  userId      String
  messages    Message[]
  context     Json
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

model Message {
  id              String   @id @default(uuid())
  conversationId  String
  role            String   // user, assistant
  content         String
  intent          String
  createdAt       DateTime @default(now())
}

model Memory {
  id          String   @id @default(uuid())
  userId      String
  key         String
  value       Json
  importance  Float
  lastAccess  DateTime
}
```

**Example products:**
- Therapy Chatbot — Emotional support with memory
- Learning Assistant — Tutoring with progress tracking
- Customer Support — Context-aware support bot

---

## Template Structure

Every template follows this structure:

```
templates/<template-name>/
├── README.md                   # Template documentation
├── .studio/
│   └── projects/<template-name>/
│       ├── pipelines/          # 3-5 working pipelines
│       │   ├── main-workflow.pipeline.yaml
│       │   ├── analysis.pipeline.yaml
│       │   └── validation.pipeline.yaml
│       ├── contracts/          # Matching contracts
│       │   ├── main-output.contract.yaml
│       │   ├── analysis-output.contract.yaml
│       │   └── validation-output.contract.yaml
│       ├── agents/             # Configured agents
│       │   ├── primary.agent.yaml
│       │   └── validator.agent.yaml
│       ├── tools/              # Domain-specific tools
│       │   ├── domain-tool.tool.yaml
│       │   └── helper.tool.yaml
│       └── inputs/             # Example inputs
│           ├── example-1.input.yaml
│           └── example-2.input.yaml
├── prisma/
│   └── schema.prisma           # Database schema starter
├── src/
│   ├── index.ts                # Entry point
│   └── lib/                    # Helper functions
├── package.json
└── tsconfig.json
```

## Template Specification

This section is the **formal contract** for template authors and for the validation CLI (STU-70). User-facing documentation is in the sections above.

### Required Files

| Path | Status | Notes |
|------|--------|-------|
| `template.yaml` | Required | Template metadata — see format below |
| `README.md` | Required | User-facing documentation |
| `.studio/projects/{{TEMPLATE_NAME}}/pipelines/` | Required | ≥2 `.pipeline.yaml` files |
| `.studio/projects/{{TEMPLATE_NAME}}/contracts/` | Required | ≥1 `.contract.yaml` per pipeline |
| `.studio/projects/{{TEMPLATE_NAME}}/agents/` | Required | ≥1 `.agent.yaml` file |
| `.studio/projects/{{TEMPLATE_NAME}}/tools/` | Optional | Builtins are allowed |
| `.studio/projects/{{TEMPLATE_NAME}}/inputs/` | Required | ≥1 fixture input for smoke testing |
| `prisma/schema.prisma` | Required | Database schema starter |
| `src/index.ts` | Required | Entry point — `src/` must be non-empty |
| `package.json` | Required | Node package definition |
| `tsconfig.json` | Optional | TypeScript config |

### `template.yaml` Format

```yaml
name: software
version: 1.0.0
description: "Code generation and modification workflows"
category: software   # software | finance | analysis | data | conversation
min_studio_version: "1.0.0"
requires:
  pipelines: 2        # minimum pipeline count
  contracts: true     # contract count ≥ pipeline count
  agents: 1           # minimum agent count
  schema: true        # prisma/schema.prisma must exist
```

### Placeholder System

Placeholders use `{{DOUBLE_BRACES}}` syntax and are replaced during `studio init`.

**Built-in placeholders:**

| Placeholder | Value | Example |
|-------------|-------|---------|
| `{{PROJECT_NAME}}` | Name provided by user at `studio init` | `code-builder` |
| `{{TEMPLATE_NAME}}` | Source template name | `software` |
| `{{YEAR}}` | Current year at generation time | `2026` |

**Future placeholders** (set via `studio config set`, like `git config user.name`):

| Placeholder | Config key |
|-------------|------------|
| `{{AUTHOR}}` | `user.name` |
| `{{EMAIL}}` | `user.email` |
| `{{DESCRIPTION}}` | `user.description` |

**Where placeholders can appear:**
- Any file's contents
- Filenames — e.g., `{{PROJECT_NAME}}.config.ts`
- Directory names — e.g., `.studio/projects/{{TEMPLATE_NAME}}/`

**Error behavior:**
- Unresolved placeholder (config key not set) → generation fails, lists all missing placeholders
- Unknown placeholder (not in the table above) → generation fails, does not silently skip

### Validation Rules

`studio validate template <path>` runs two levels in sequence and stops at first failure.

**Level 1 — Structural** (fast, no parsing):
- `template.yaml` exists
- `README.md` exists
- `.studio/projects/` contains exactly one subdirectory
- Pipeline count ≥ `requires.pipelines`
- Contract count ≥ pipeline count
- Agent count ≥ `requires.agents`
- `prisma/schema.prisma` exists (when `requires.schema: true`)
- `src/` directory exists and is non-empty
- `inputs/` directory exists with at least one `.input.yaml` file

**Level 2 — Semantic** (parse + cross-reference):
- All YAML files parse without errors
- Every pipeline stage references a contract that exists in `contracts/`
- Every pipeline stage references an agent that exists in `agents/`
- Every tool in an agent's `tools:` list exists in `tools/` or is a builtin
  _(Builtins: `repo_manager-read_file`, `repo_manager-write_file`, `repo_manager-list_files`, `shell-run_command`, `search-search_codebase`)_
- Every tool in a contract's `required_tools:` exists in `tools/` or is a builtin
  _(Builtins: `repo_manager-read_file`, `repo_manager-write_file`, `repo_manager-list_files`, `shell-run_command`, `search-search_codebase`)_
  _(Note: contracts use dot-format `repo_manager.write_file`, the engine transforms to tiret-format `repo_manager-write_file` internally — the validator reports errors using tiret-format)_
- No unknown placeholders appear in any file or filename

**Output format:**
```
✓ Structural validation passed
✗ Semantic validation failed
  contracts/qa-review.contract.yaml: required_tool 'repo_manager-commit' not found
  agents/coder.agent.yaml: tool 'git-push' not found in tools/ or builtins
```

### Testing Requirements

A template must pass all three levels before it can be merged.

**Stage 1 — Validate:**
```bash
studio validate template ./templates/<name>
```
Zero errors from structural + semantic validation.

**Stage 2 — Generation test:**
```bash
studio init --template <name> --name test-project --output /tmp/studio-test
studio validate template /tmp/studio-test
```
Verifies placeholder replacement produces a valid project — no unresolved `{{...}}`, all filenames valid, structure intact.

**Stage 3 — Pipeline smoke test:**
```bash
cd /tmp/studio-test
studio run <template-name>/first-pipeline \
  --input-file .studio/projects/<name>/inputs/example-1.input.yaml \
  --dry-run
```
At least one pipeline runs end-to-end against a fixture input. The `--dry-run` flag mocks all LLM calls — use it in CI to avoid API costs. Real API in manual testing.

> Every template **must** ship with at least one `inputs/*.input.yaml` fixture. This file doubles as documentation and as test data.

---

## Using Templates

### Generate a new app

```bash
studio init --template <type> --name <project-name>
```

Examples:
```bash
studio init --template software --name code-builder
studio init --template finance --name expense-tracker
studio init --template analysis --name wiki-creator
studio init --template data --name compliance-validator
studio init --template conversation --name therapy-bot
```

### What happens

1. Studio copies the entire template directory
2. Replaces template placeholders with your project name
3. Initializes git repository
4. Creates `.studio/config.yaml` with provider settings
5. Generates `README.md` with getting started instructions

### Immediate next steps

```bash
cd <project-name>
npm install
studio config set provider anthropic --api-key $KEY
npm run dev
```

The app is **functional immediately**. You can run the included pipelines.

### Customization workflow

1. **Test the defaults** — Run the included pipelines to understand the pattern
2. **Extend pipelines** — Add your own stages or modify existing ones
3. **Add tools** — Create `.tool.yaml` files for your specific needs
4. **Extend schema** — Add tables/fields to `prisma/schema.prisma`
5. **Build UI/CLI** — Add your application layer in `src/`

## Creating Custom Templates

### When to create a custom template

Create a custom template when:
- You're building multiple apps with similar patterns
- You have domain-specific workflows to standardize
- You want to share patterns with your community

### Structure requirements

A valid template must satisfy all rules defined in the [Template Specification](#template-specification) section above.

Run `studio validate template <path>` to check your template against the full ruleset.

### Testing templates

```bash
cd templates/my-template
npm test
```

This should:
- Validate all YAML files
- Run test pipelines
- Check contracts pass
- Verify database migrations work
- Ensure code compiles

### Publishing templates

```bash
studio publish template ./my-custom-template
```

This submits your template to the community registry for others to discover and use.

## Template Versioning

Templates follow semantic versioning:

```yaml
# templates/software/template.yaml
name: software
version: 1.2.0
```

When you generate an app from a template, the version is locked in `.studio/registry.lock.json`.

You can update later:
```bash
studio template update software --version 1.3.0
```

This updates pipelines/contracts/tools from the template, but **preserves your customizations**.

## Template Registry (Future)

```bash
# Search templates
studio search templates analysis
→ analysis/ (official)
→ legal-analysis/ (by @john)
→ medical-analysis/ (by @jane)

# Install custom template
studio template add @john/legal-analysis

# Use custom template
studio init --template @john/legal-analysis --name my-tool
```

## Examples: Template → Product

### Code Builder

**Template:** `software`

**Customizations:**
- Extended `feature-builder` pipeline with IDE-specific tools
- Added VSCode extension integration
- Extended DB schema for project tracking
- Built CLI wrapper with `studio run` integration

**Result:** Full IDE-integrated code generation tool

---

### ADHD Finance

**Template:** `finance`

**Customizations:**
- Added ADHD-specific categorization rules
- Built "panic mode" pipeline for urgent decisions
- Extended schema for goal tracking
- Built Next.js web app + mobile app
- Integrated Plaid for bank connections

**Result:** Specialized finance tool for neurodivergent users

---

### Wiki Creator

**Template:** `analysis`

**Customizations:**
- Added book-specific parsing pipeline
- Extended entity recognition for characters/places/themes
- Added cross-referencing pipeline
- Built wiki page generator
- Extended schema for books/pages/entities/links

**Result:** Book → Wiki transformation tool

---

### Voice Training

**Template:** `analysis`

**Customizations:**
- Added audio processing pipeline
- Built pitch/resonance analysis tools
- Added exercise recommendation pipeline
- Built Duolingo-style UI
- Extended schema for users/recordings/exercises/progress

**Result:** Voice feminization training app

**Same template, completely different product.**

---

## Frequently Asked Questions

### Do I need to use a template?

No. You can create `.studio/` manually and define everything yourself. Templates just save time.

### Can I modify template code after generation?

**Yes, absolutely.** Once generated, the code is yours. Modify anything. The template is just a starting point.

### Can I combine multiple templates?

Not directly, but you can:
1. Generate from template A
2. Copy specific pipelines/tools from template B
3. Merge manually

### What if my use case doesn't fit any template?

Start with the closest template and heavily customize. Or create your own template and share it.

### Can templates be upgraded after generation?

Yes, but carefully. `studio template update <name>` will update shared components while preserving your customizations. Always commit before updating.

---

## Contributing Templates

Want to contribute a template to the official collection?

Requirements:
1. Real-world validation (template used in at least 2 actual products)
2. Complete documentation
3. Working test suite
4. Clear differentiation from existing templates
5. Community need demonstrated

Submit a PR to `Studio/templates/` with your template + documentation.

---

**See also:**
- **[CLAUDE.md](CLAUDE.md)** — Core Studio documentation
- **[README.md](README.md)** — Public-facing overview
- **[BUSINESS_PLAN.md](BUSINESS_PLAN.md)** — Studio's business model and philosophy