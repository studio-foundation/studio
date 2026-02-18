# Skills

## What are Skills?

Skills are pluggable tool packs that can be dynamically loaded into the runner. A skill is a collection of related tools packaged together, typically defined in YAML configuration files with accompanying code.

## Status

**NOT YET IMPLEMENTED** - This is a placeholder for future functionality.

## Future Implementation

Skills will allow:
- Loading tools from external YAML + TypeScript/JavaScript files
- Packaging related tools together (e.g., "database skill", "api skill")
- Dynamic tool discovery and registration
- Versioning and dependency management for tool sets

## Planned Structure

```
skills/
├── database/
│   ├── skill.yaml
│   └── tools.ts
├── api/
│   ├── skill.yaml
│   └── tools.ts
└── custom/
    ├── skill.yaml
    └── tools.ts
```

Where `skill.yaml` would define:
- Skill metadata (name, version, description)
- Tool definitions (names, descriptions, parameters)
- Dependencies on other skills or system requirements

And `tools.ts` would implement:
- The actual tool execution functions
- Any helper utilities needed by the tools

## Implementation TODO

- [ ] Design skill manifest format (YAML schema)
- [ ] Implement skill loader (scan directories, parse YAML, load code)
- [ ] Add skill validation (check required fields, validate tool signatures)
- [ ] Support skill dependencies and version constraints
- [ ] Create example skills for common use cases
