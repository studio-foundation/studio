# Code Conventions

## File Organization

- Read existing files before modifying them
- Match the naming conventions already present in the codebase
- Place new files near related existing files

## TypeScript

- Prefer `const` over `let`; avoid `var`
- Use explicit return types on public functions
- Avoid `any` — use `unknown` and narrow with type guards

## Testing

- Write tests for new behavior before (or alongside) the implementation
- Test file lives next to source: `foo.ts` → `foo.test.ts`
- Describe blocks group related tests; `it` describes behavior

## Error Handling

- Throw descriptive errors with context: `throw new Error(\`Could not load '${name}': ${err.message}\`)`
- Log warnings (not errors) for non-fatal, recoverable issues
