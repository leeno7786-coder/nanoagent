---
name: test-driven-development
kind: execution_skill
version: 1
enabled: true
description: 'Test-driven development: red-green-refactor cycle, failing tests first,
  minimal implementation, and refactor with verification'
long_description: 'Enforces strict TDD workflow: write a failing test, implement the
  minimum code to pass, refactor while keeping tests green, and report cycle evidence.'
author: omega
tags:
- testing
- tdd
keywords:
- test-driven-development
- red-green-refactor
skill_class: testing_skill
intents:
- USE_SKILL
execution_kinds:
- TEST
- WRITE
- DEBUG
domains:
- testing
- development
allowed_tools:
- read_files
- search_repo
- inspect_git_diff
- run_tests
- write_file
- edit_file
forbidden_tools:
- run_command
- web_fetch
- browser_navigate
- browser_read
- desktop_screenshot
- desktop_click
- patch_file
safety_class: write_safe
requires_confirmation_for: []
max_steps: 35
max_duration_ms: 600000
max_files_changed: 15
evidence_required:
- test_written
- test_executed
- test_passed
- implementation_driven
completion_criteria:
- red_green_refactor_cycle_completed
- tests_passing
- code_quality_maintained
failure_classes:
- test_failure
- implementation_mismatch
- incomplete_cycle
output_schema:
  type: object
  properties:
    summary:
      type: string
      title: Overview of TDD cycle completion
    test_file:
      type: string
      title: Path to written test file
    implementation_file:
      type: string
      title: Path to implementation file
    cycle_stage:
      type: string
      enum:
      - red
      - green
      - refactor
      title: Current TDD cycle stage
    tests_run:
      type: integer
      title: Number of tests executed
    tests_passed:
      type: integer
      title: Number of tests passed
    tests_failed:
      type: integer
      title: Number of tests failed
  required:
  - summary
  - tests_run
  - tests_passed
---

# test-driven-development

> **Execution contract (Omega):** This skill executes ONLY inside an Omega Auto dispatch. It must NOT create new top-level goals, continue work beyond the dispatch, or use any tool outside its declared `allowed_tools`. It returns structured evidence matching the declared `output_schema`.

Use this skill when the user wants strict test-driven development rather than broad testing strategy work.

## Instructions

You are a TDD practitioner. Follow red-green-refactor on every change.

## Red-Green-Refactor

1. **Red**: Write a failing test that describes the desired behavior.
2. **Green**: Write the minimum code to make it pass.
3. **Refactor**: Clean up the code while keeping tests green.

## Rules

- Do not write production code without a failing test first.
- Keep each cycle small: one behavior, one test, one minimal fix.
- Run the focused test after each step; run the relevant suite before finishing.
- Prefer real collaborators over mocks unless the boundary is external or expensive.
- Report which cycle stage you reached and which tests proved the change.
