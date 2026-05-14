# Templates

Templates are starting points for common pipeline patterns. They package proven configurations — pipelines, contracts, agents, and a workspace skeleton — so you don't start from a blank `.studio/`.

A template is not a finished product. It is a structured starter you customize into your own pipeline.

---

## Status

| Template | Status | Notes |
|----------|--------|-------|
| `software` | ✅ Functional | Complete pipelines, tools, and DB schema. Run end-to-end. |
| `finance` | 🚧 Starter | Structure and pipelines defined. Domain tools (bank-api, etc.) are stubs, wire to your own integrations. |
| `analysis` | 🚧 Starter | Structure and pipelines defined. Domain tools (text-processor, etc.) are stubs. |
| `data` | 🚧 Starter | Structure only. |
| `conversation` | 🚧 Starter | Structure only. |

> Only the `software` template is production-ready. The others are structural starters: structure, pipelines, and contracts are defined, but the domain tools are stubs. Expect to wire your own integrations.

---

## What `studio init --template <name>` does

1. Copies the template directory into your project.
2. Replaces template placeholders (`{{PROJECT_NAME}}`, `{{TEMPLATE_NAME}}`, etc.) with your values.
3. Initializes a git repository.
4. Writes `.studio/config.yaml` with provider settings (gitignored).
5. Generates `README.md` with getting started instructions.

You then `npm install`, configure a provider, and run an included pipeline.

```bash
studio init --template software --name code-builder
cd code-builder
npm install
studio config set provider anthropic --api-key $ANTHROPIC_API_KEY
studio run software/feature-builder --input "Add dark mode support"
```

---

## Official templates

### `software` — code generation and modification

Production-ready.

**Use cases:** code generators, feature builders, bug fixers, refactoring tools, API scaffolders.

**Included pipelines:**
- `feature-builder`: generate new features from descriptions
- `bug-fixer`: analyze and fix bugs
- `refactor`: restructure code while preserving behavior

**Included tools:**
- `repo_manager-read_file`
- `repo_manager-write_file`
- `repo_manager-list_files`
- `shell-run_command`
- `search-search_codebase`

**Contracts include:**
- Anti-theatre validation (must actually call write tools)
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

Used by [Little Chef](https://github.com/studio-foundation/little-chef-by-studio).

---

### `finance` — transaction analysis and budget management

Structural starter. Domain tools are stubs — wire your own integrations.

**Use cases:** personal finance managers, expense trackers, budget planners, invoicing tools.

**Included pipelines:**
- `transaction-analysis`: categorize and analyze transactions
- `budget-planning`: generate budget recommendations
- `account-splitting`: auto-split income across accounts

**Included tools (stubs):**
- `bank-api` (intended for Plaid or similar)
- `categorization` (intended for ML-based transaction categorization)
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

---

### `analysis` — content extraction and structuring

Structural starter. Domain tools are stubs — wire your own integrations.

**Use cases:** document analyzers, entity extractors, text structurers, content parsers.

**Included pipelines:**
- `content-extraction`: extract structured content from unstructured input
- `entity-recognition`: identify and classify entities
- `structure-generation`: generate hierarchical structures

**Included tools (stubs):**
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

Used by [Wiki Creator](https://github.com/studio-foundation/wiki-creator). The same pattern works for text, audio, video, or any content that needs analysis and structuring.

---

### `data` — validation, transformation, and compliance

Structural starter. Domain tools are stubs — wire your own integrations.

**Use cases:** data validators, ETL pipeline auditors, schema migrators, compliance checkers.

**Included pipelines:**
- `schema-validation`: validate data against schemas
- `transformation`: transform data between formats
- `compliance-check`: check regulatory compliance

**Included tools (stubs):**
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

---

### `conversation` — dialogue management and memory

Structural starter. Domain tools are stubs — wire your own integrations.

**Use cases:** chatbots, virtual assistants, support bots.

**Included pipelines:**
- `dialogue-management`: handle multi-turn conversations
- `memory-storage`: store and retrieve conversation context
- `intent-classification`: classify user intents
- `response-generation`: generate contextual responses

**Included tools (stubs):**
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

---

## Template structure

Every template follows this layout:

```
templates/<template-name>/
├── README.md                   # Template documentation
├── template.yaml               # Template metadata
├── .studio/
│   └── projects/<template-name>/
│       ├── pipelines/          # *.pipeline.yaml
│       ├── contracts/          # *.contract.yaml
│       ├── agents/             # *.agent.yaml
│       ├── tools/              # *.tool.yaml
│       └── inputs/             # fixture inputs
├── prisma/
│   └── schema.prisma           # Database schema starter
├── src/
│   ├── index.ts                # Entry point
│   └── lib/                    # Helper functions
├── package.json
└── tsconfig.json
```

---

## Customization workflow

1. **Run the defaults.** Execute the included pipelines first to understand the pattern.
2. **Extend pipelines.** Add stages or modify existing ones.
3. **Add tools.** Create `.tool.yaml` files for your specific needs.
4. **Extend the schema.** Add tables/fields to `prisma/schema.prisma`.
5. **Build your application layer.** UI, CLI, or API on top of the engine.

Once generated, the code is yours. Modify anything.

---

## Frequently asked questions

### Do I need to use a template?

No. You can create `.studio/` manually and define everything yourself. Templates just save time.

### Can I combine multiple templates?

Not directly. Generate from the closest template, then copy specific pipelines or tools from another template and merge manually.

### What if my use case doesn't fit any template?

Start with the closest template and customize heavily. Or author your own template (see below).

### Can templates be upgraded after generation?

Not yet. `studio template update` is on the roadmap. For now, manually copy updated pipeline/contract files from the template source. Always commit before pulling updates.

---

## Custom templates

You can author your own templates for patterns specific to your domain or your team. The full specification — required files, `template.yaml` format, placeholder system, validation rules, and the test workflow — lives in [docs/TEMPLATE_AUTHORING.md](./docs/TEMPLATE_AUTHORING.md).

To validate a template against the full ruleset:

```bash
studio validate template <path>
```

To share a template with the community, submit it to [studio-community](https://github.com/studio-foundation/studio-community) under `templates/`. The `studio registry` CLI is not yet wired up to install from there directly — for now, clone the template repo manually.

---

**See also:**
- [README.md](./README.md): public-facing overview
- [PHILOSOPHY.md](./PHILOSOPHY.md): design principles
- [docs/TEMPLATE_AUTHORING.md](./docs/TEMPLATE_AUTHORING.md): full template specification for authors
