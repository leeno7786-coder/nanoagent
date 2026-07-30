---
name: create-skill
description: Create a new .md skill for this system by having the agent generate the SKILL.md from a user description, write the file, and validate it.
user-invocable: true
triggers:
  - "create skill"
  - "new skill"
  - "build a skill"
  - "make a skill"
  - "skill wizard"
  - "scaffold skill"
  - "generate skill"
---

# Create Skill — Agent-Driven Generation

This skill uses the agent model to create a new `.md` skill for this system. The user describes what they want in natural language, the agent generates the SKILL.md content, writes the file, and validates it.

## When to use

- The user wants to create a new reusable skill for this project.
- The user has a repeated workflow they want to encode as a skill.
- The user asks "how do I make a skill" or "create a skill for X".
- The user says "generate a skill" or "scaffold a skill".

## Workflow

### 1. Gather requirements from the user

Ask the user for a brief description of what the skill should do. Use `execute_command` to check that the target `skills/<slug>/` directory does not already exist.

Prompt the user:

```
What should this skill do? Give a brief description (1-2 sentences).
What slug would you like? (lowercase, hyphens, e.g. adding-docker)
```

If the user doesn't provide a slug, suggest one derived from their description.

### 2. Generate the SKILL.md content

Use the LLM to draft the full SKILL.md content. Pass the user's description and slug as context and ask the model to produce:

- **Frontmatter** with `name`, `description`, `user-invocable: true`, and `triggers` derived from the description
- **Body** following the standard skill structure:
  - `# Human-Readable Title`
  - One-sentence summary
  - `## When to use` — bullet points
  - `## Workflow` — numbered steps with concrete tool names (`execute_command`, `read_file`, `edit_file`, `write_file`)
  - `## Notes` — edge cases and safety warnings

The model must follow the conventions of existing skills in `skills/`:
- No filler — every section has actionable content
- No secrets or machine-specific paths
- One skill per workflow
- Direct, no-fluff tone

### 3. Write the file

Use `write_file` to save the generated content to `skills/<slug>/SKILL.md`.

Then use `execute_command` to verify the file was written:

```bash
dir skills\<slug>\SKILL.md
```

### 4. Validate

Read the file back with `read_file` and check:

- Frontmatter parses correctly (YAML between `---` delimiters)
- `name` matches the slug exactly
- `description` ends with a clear trigger phrase
- `triggers` are natural phrases a user would actually say
- Body sections are non-empty and use concrete tool/command names
- No secrets or machine-specific paths leaked into the body

If validation fails, use `edit_file` to fix the issues and re-validate.

### 5. Confirm

After validation passes, confirm to the user:

```
Skill `<slug>` created at `skills/<slug>/SKILL.md`.
It will be available on the next chat in this workspace.
```

## Notes

- Prefer **one skill per workflow** — avoid megaskills that try to cover every situation
- Update an existing skill instead of adding a duplicate if the workflow evolves
- Skills are loaded from `skills/`, `~/.qwen-agent-tui/skills/`, `~/.agents/skills/`, and `~/.claude/skills/` — the project `skills/` directory takes priority
- If the user wants to add supporting files (templates, references), create them in `skills/<slug>/` alongside `SKILL.md`
