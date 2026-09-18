---
name: code-review
description: |
  Code review practices for constructive feedback, catching bugs, and
  fostering knowledge sharing through systematic analysis.
triggers:
  - code review
  - review pull request
  - review pr
  - code quality
  - pull request review
---

# Code Review Excellence

Transform code reviews from gatekeeping to knowledge sharing through
constructive feedback, systematic analysis, and collaborative improvement.

## Core Principles

### Review Mindset

- Catch bugs and edge cases
- Ensure code maintainability
- Share knowledge across team
- Enforce coding standards

### Effective Feedback

- Specific and actionable
- Educational, not judgmental
- Focused on the code, not the person
- Balanced (praise good work too)
- Prioritized (critical vs nice-to-have)

### What to Look For

- Correctness: Does the code do what it should?
- Security: Are there vulnerabilities?
- Performance: Are there obvious bottlenecks?
- Testability: Is the code testable?
- Maintainability: Will this be easy to change?

## Workflow

1. Understand the context (read the PR description and linked issues)
2. Review the diff systematically
3. Run the code locally if needed
4. Provide clear, actionable feedback
5. Approve or request changes with justification

After `git_status` / `git_diff` and reading the relevant files, write the review.
Do not re-run those discovery tools or re-read the same files.
