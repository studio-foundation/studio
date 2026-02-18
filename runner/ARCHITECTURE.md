# @studio/runner Architecture

## Purpose
Multi-provider LLM agent runner with tool execution framework.

## Core Components

### 1. Runner (`src/runner.ts`)
Main entry point providing `runAgent()` function that:
- Loads agent profiles from configs
- Constructs context from sources
- Builds prompts with system/user messages
- Routes to provider (OpenAI/Anthropic)
- Executes tools on demand
- Returns final response

### 2. Providers (`src/providers/`)
- **provider.ts**: `LLMProvider` interface
- **openai.ts**: OpenAI implementation (gpt-4, gpt-4-turbo)
- **anthropic.ts**: Anthropic implementation (claude-3-opus, claude-3-sonnet)
- **registry.ts**: Provider factory/registry

### 3. Tools (`src/tools/`)
- **tool-executor.ts**: Executes tool calls from LLM responses
- **tool-registry.ts**: Registers and retrieves tool definitions
- **builtin/repo-manager.ts**: File operations (read, write, list)
- **builtin/shell.ts**: Command execution
- **builtin/search.ts**: Codebase search (grep, find)

### 4. Context (`src/context/`)
- **context-pack.ts**: Assembles context window from multiple sources
- **context-sources.ts**: Loaders for file, directory, git, web sources

### 5. Prompt Builder (`src/prompt-builder.ts`)
Constructs final prompt with:
- Agent profile/system message
- Context window
- User message
- Tool definitions

## Agent Profiles
YAML configs in `configs/agents/`:
- generic.agent.yaml
- code-generator.agent.yaml
- analyst.agent.yaml

## Dependencies
- @studio/contracts: Shared types and schemas
- openai: OpenAI SDK
- @anthropic-ai/sdk: Anthropic SDK

## Data Flow
```
User Request
  → Load Agent Profile
  → Build Context
  → Build Prompt
  → Provider.chat()
  → Tool Execution Loop
  → Final Response
```
