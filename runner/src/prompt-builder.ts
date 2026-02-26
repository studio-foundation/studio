/**
 * Prompt builder - constructs messages for LLM with retry escalation
 */

import type { Message, AgentConfig, OutputContract, ResolvedContextPack, ToolCall } from '@studio/contracts';
import type { SkillContent } from './tools/skills/skill-loader.js';

export interface ExecutionContext {
  attempt: number;
  previous_failures?: Array<{
    error: string;
    tool_calls_count: number;
  }>;
}

export interface TaskInput {
  description: string;
  expected_output?: string;
  stage_kind?: string;
  contract_name?: string;
}

export interface GroupFeedbackContext {
  iteration: number;
  max_iterations: number;
  rejection_reason: string;
  rejection_details?: string[];
}

export interface AgentContext {
  previous_outputs?: Record<string, unknown>;
  previous_tool_results?: Record<string, ToolCall[]>;
  repo_files?: string[];
  additional_context?: string;
  group_feedback?: GroupFeedbackContext;
  context_packs?: ResolvedContextPack[];
  startup_context?: Record<string, string>;
}

export interface PromptBuildConfig {
  agent: AgentConfig;
  task: TaskInput;
  context: AgentContext;
  executionContext?: ExecutionContext;
  outputContract?: OutputContract;
  promptSnippets?: string[];
  skills?: SkillContent[];
}

/**
 * Build prompt messages with retry escalation support
 */
export function buildPrompt(config: PromptBuildConfig): Message[] {
  const { agent, task, context, executionContext } = config;
  const messages: Message[] = [];

  // Build system message
  let systemContent = agent.system_prompt || 'You are a helpful AI assistant.';

  // Add rules about tool calls for code_generation stage
  if (task.stage_kind === 'code_generation') {
    systemContent += `

## CRITICAL: Code Generation Workflow

You MUST follow this two-phase workflow:

### Phase 1 — Make changes using tools
- Use repo_manager-read_file to read existing files before modifying them
- Use repo_manager-write_file to create or update files (REQUIRED — at least one call)
- Use repo_manager-list_files to explore the repository structure if needed

DO NOT just describe what changes should be made — actually make them using the tools.

### Phase 2 — Return JSON summary
Once ALL file changes are complete and you have no more tool calls to make, your final message MUST be a valid JSON object summarizing what you did. No markdown, no code blocks, no explanatory text — just the JSON.
`;
  }

  // Add output format with concrete schema when available
  const contract = config.outputContract;
  if (contract?.schema?.required_fields?.length) {
    const fields = contract.schema.required_fields;
    systemContent += `

## REQUIRED OUTPUT FORMAT

You MUST ${task.stage_kind === 'code_generation' ? 'end with' : 'respond with'} a valid JSON object. ${task.stage_kind === 'code_generation' ? 'Your final message (after all tool calls)' : 'Your entire response'} must be parseable JSON — no markdown, no code blocks, no explanatory text${task.stage_kind === 'code_generation' ? ' in that final message' : ' before or after'}.

The JSON object MUST contain these fields:
${fields.map((f: string) => `- "${f}" — ${getFieldTypeHint(f)}`).join('\n')}

Example structure:
{
${fields.map((f: string) => `  "${f}": ${getFieldExample(f)}`).join(',\n')}
}

CRITICAL: If your response is not valid JSON with ALL required fields, it will be rejected and you will be asked to retry.
Pay attention to field types: arrays must be arrays, objects must be objects. Do NOT flatten structured fields into plain strings.`;

    // Inject accepted values for rejection detection fields
    const rd = contract.post_validation?.rejection_detection;
    if (rd?.field && rd?.approved_values?.length) {
      systemContent += `

The "${rd.field}" field MUST be one of: ${rd.approved_values.map((v: string) => `"${v}"`).join(', ')}.
Any other value means rejection.`;
    }
  } else if (task.contract_name || task.expected_output) {
    systemContent += `

## Output Format

${task.expected_output || `Provide your response according to the ${task.contract_name} contract.`}
`;
  }
  // Inject prompt snippets from active tool plugins
  if (config.promptSnippets && config.promptSnippets.length > 0) {
    systemContent += '\n\n' + config.promptSnippets.join('\n\n');
  }

  // Inject skills (.studio/skills/*.skill.md) declared by the agent
  if (config.skills && config.skills.length > 0) {
    const skillChunks = config.skills.map(s => `## Skill: ${s.name}\n\n${s.content}`);
    systemContent += '\n\n' + skillChunks.join('\n\n---\n\n');
  }

  messages.push({
    role: 'system',
    content: systemContent
  });

  // Build user message with context
  let userContent = '';

  // Group feedback FIRST — must be the most prominent thing the model sees
  if (context.group_feedback) {
    const fb = context.group_feedback;
    userContent += `## ⚠️ REVISION REQUIRED — Iteration ${fb.iteration + 1}/${fb.max_iterations}\n\n`;
    userContent += `Your previous implementation was **REJECTED**. You MUST address ALL issues below before proceeding.\n\n`;
    userContent += `**Reason:** ${fb.rejection_reason}\n\n`;
    if (fb.rejection_details?.length) {
      userContent += `**Issues to fix:**\n`;
      for (const detail of fb.rejection_details) {
        userContent += `- ${detail}\n`;
      }
      userContent += '\n';
    }
    userContent += `DO NOT repeat the same approach. Each issue above MUST be resolved in your new implementation.\n\n---\n\n`;
  }

  // Add previous outputs if any
  if (context.previous_outputs && Object.keys(context.previous_outputs).length > 0) {
    userContent += '## Previous Stage Outputs\n\n';
    for (const [stage, output] of Object.entries(context.previous_outputs)) {
      userContent += `### ${stage}\n\`\`\`json\n${JSON.stringify(output, null, 2)}\n\`\`\`\n\n`;
    }
  }

  // Add repository context if provided
  if (context.repo_files && context.repo_files.length > 0) {
    userContent += `## Repository Files\n\nRelevant files:\n${context.repo_files.map(f => `- ${f}`).join('\n')}\n\n`;
  }

  // Add additional context
  if (context.additional_context) {
    userContent += `## Additional Context\n\n${context.additional_context}\n\n`;
  }

  // Render pipeline startup context — each key as a ### section
  if (context.startup_context && Object.keys(context.startup_context).length > 0) {
    userContent += '## Pipeline Startup Context\n\n';
    for (const [key, value] of Object.entries(context.startup_context)) {
      userContent += `### ${key}\n\`\`\`\n${value}\n\`\`\`\n\n`;
    }
  }

  // Add context packs — each as a top-level ## section, sections as ###
  if (context.context_packs?.length) {
    for (const pack of context.context_packs) {
      userContent += `## ${pack.name}`;
      if (pack.description) userContent += ` — ${pack.description}`;
      userContent += '\n\n';
      for (const section of pack.sections) {
        userContent += `### ${section.title}\n\n${section.content}\n\n`;
      }
    }
  }

  // Add previous stage tool results (discoveries) — placed last before the task
  // so they have high recency salience for the LLM
  if (context.previous_tool_results && Object.keys(context.previous_tool_results).length > 0) {
    userContent += renderToolResults(context.previous_tool_results);
  }

  // Add task description
  userContent += `## Task\n\n${task.description}`;

  // Add retry escalation if this is a retry attempt
  if (executionContext && executionContext.attempt > 1) {
    userContent += getRetryEscalationMessage(executionContext);
  }

  messages.push({
    role: 'user',
    content: userContent
  });

  return messages;
}

/**
 * Get retry escalation message based on attempt number
 * Progressively stronger messaging to enforce tool usage
 */
function getRetryEscalationMessage(executionContext: ExecutionContext): string {
  const { attempt, previous_failures } = executionContext;
  let message = '\n\n---\n\n';

  const hasStringError = previous_failures?.some(f => f.error.includes('Expected object output, got string'));
  const hasMissingTool = previous_failures?.some(f => f.error.includes('Required tool'));

  if (attempt === 2) {
    message += `⚠️ **RETRY ATTEMPT ${attempt}**

Your previous attempt failed. Please review the errors below and fix the issues:

`;
    previous_failures?.forEach((failure, idx) => {
      message += `Attempt ${idx + 1}: ${failure.error}\n`;
      if (failure.tool_calls_count === 0) {
        message += `  → Problem: No tool calls were made. You need to use the available tools.\n`;
      }
    });

    if (hasStringError) {
      message += `\n⚠️ Your response was plain text, not JSON. Your FINAL message (after all tool calls) must be ONLY a raw JSON object — no explanations, no markdown.`;
    }
    if (hasMissingTool) {
      message += `\n⚠️ You must use repo_manager-write_file to make actual file changes, not just read or explore.`;
    }

    message += `\nMake sure to use the tools available to you to complete the task.`;
  } else if (attempt === 3) {
    message += `🚨 **CRITICAL: RETRY ATTEMPT ${attempt}**

Multiple previous attempts have failed. This is your ${attempt}rd attempt.

Previous errors:
`;
    previous_failures?.forEach((failure, idx) => {
      message += `- Attempt ${idx + 1}: ${failure.error} (tool_calls: ${failure.tool_calls_count})\n`;
    });

    message += `
**YOU MUST:**
1. Use repo_manager-write_file to create/modify files — reading and exploring is NOT enough
2. After all tool calls are done, send ONE final message that is ONLY a raw JSON object
3. No markdown, no explanations, no code fences — just {"summary": "...", ...}

DO NOT just provide instructions or descriptions. EXECUTE the changes, then return JSON.`;
  } else if (attempt >= 4) {
    message += `⛔ **FINAL WARNING: RETRY ATTEMPT ${attempt}**

This is attempt ${attempt}. Previous attempts all failed:

`;
    previous_failures?.forEach((failure, idx) => {
      message += `Attempt ${idx + 1}:\n  Error: ${failure.error}\n  Tool calls made: ${failure.tool_calls_count}\n\n`;
    });

    message += `
🔴 **ABSOLUTE REQUIREMENTS:**

1. Every file modification MUST use repo_manager-write_file
2. tool_calls = 0 is an AUTOMATIC FAILURE
3. You must make ACTUAL changes, not describe them
4. Read existing files before modifying them
5. Provide complete file contents, not diffs
6. Your FINAL message must be ONLY a JSON object like: {"summary": "...", "files_changed": [...]}
7. If your final message contains ANY text outside the JSON, it WILL be rejected

If you do not make real tool calls AND return valid JSON, this task will fail permanently.`;
  }

  return message;
}

/** Known field type hints for required_fields schema injection */
const FIELD_TYPE_HINTS: Record<string, string> = {
  summary: 'string',
  requirements: 'array of objects, each with relevant keys (e.g. {id, description, priority})',
  acceptance_criteria: 'array of strings',
  files_changed: 'array of objects with {path, status, changes}',
  files_to_modify: 'array of strings (file paths)',
  steps: 'array of strings',
  issues: 'array of strings or objects',
};

/** Known field example values for required_fields schema injection */
const FIELD_EXAMPLES: Record<string, string> = {
  summary: '"A concise summary of the result"',
  requirements: '[{"id": "REQ-1", "description": "...", "priority": "high"}]',
  acceptance_criteria: '["criterion 1", "criterion 2"]',
  files_changed: '[{"path": "src/file.tsx", "status": "modified", "changes": "description of changes"}]',
  files_to_modify: '["src/file.tsx", "src/utils/helper.ts"]',
  steps: '["step 1", "step 2", "step 3"]',
  issues: '["issue 1", "issue 2"]',
};

const TOOL_RESULT_MAX_CHARS = 2000;

function renderToolResults(previous_tool_results: Record<string, ToolCall[]>): string {
  let out = '';
  for (const [stage, toolCalls] of Object.entries(previous_tool_results)) {
    out += `## Previous Stage Discoveries (${stage})\n\n`;
    for (const tc of toolCalls) {
      // Use first string argument value as the display label
      const label = Object.values(tc.arguments).find(v => typeof v === 'string') ?? JSON.stringify(tc.arguments);
      out += `### ${tc.name}(${label})\n`;
      if (tc.error) {
        out += `Error: ${tc.error}\n\n`;
      } else {
        // For write operations, render the content being written from arguments
        // (the result is just {written: true} which is not useful for reviewers).
        // For all other operations, render the result as usual.
        const writeContent = typeof tc.arguments?.content === 'string'
          ? tc.arguments.content as string
          : null;
        const raw = writeContent ?? JSON.stringify(tc.result, null, 2);
        const body = raw.length > TOOL_RESULT_MAX_CHARS
          ? raw.slice(0, TOOL_RESULT_MAX_CHARS) + '\n[truncated]'
          : raw;
        out += `\`\`\`\n${body}\n\`\`\`\n\n`;
      }
    }
  }
  return out;
}

function getFieldTypeHint(field: string): string {
  return FIELD_TYPE_HINTS[field] || 'string';
}

function getFieldExample(field: string): string {
  return FIELD_EXAMPLES[field] || '"..."';
}
