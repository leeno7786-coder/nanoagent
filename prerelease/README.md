# ⚡ NanoAgent v1.1.0-alpha.1 - Prerelease

## Overview

This is a prerelease package of NanoAgent with comprehensive security hardening and self-testing capabilities.

---

## Package Contents

```
nanoagent-1.1.0-alpha.1.tgz
├── package.json          # Package metadata (version 1.1.0-alpha.1)
├── main.js               # Built main entry point (2.0 MB)
├── opentui/
│   └── index.js          # Built TUI entry point (2.0 MB)
└── assets/               # Syntax highlighting and tree-sitter files
    ├── highlights-*.scm   # Syntax highlighting themes
    └── tree-sitter-*.wasm # Tree-sitter parsers
```

---

## Installation

### Option 1: Download and Extract

1. Download the tarball:
   ```bash
   # From GitHub (after uploading)
   wget https://github.com/leeno7786-coder/qwen-agent-tui/releases/download/v1.1.0-alpha.1/nanoagent-1.1.0-alpha.1.tgz
   
   # Or from local build
   # The file is in the prerelease/ directory
   ```

2. Extract the tarball:
   ```bash
   tar -xzf nanoagent-1.1.0-alpha.1.tgz
   cd package
   ```

3. Install dependencies:
   ```bash
   bun install
   ```

### Option 2: Clone and Build from Source

```bash
# Clone the repository
git clone https://github.com/leeno7786-coder/qwen-agent-tui.git
cd qwen-agent-tui

# Checkout main branch (contains all features)
git checkout main

# Install dependencies
bun install

# Build the package
bun run build:all

# The built files will be in the dist/ directory
```

---

## Running

### Start the TUI

```bash
# From the extracted package
bun run start

# Or with specific options
bun run start:tui
```

### Run in Headless Mode

```bash
# Run a single task
bun run agent --prompt "Your task here"

# With workspace
bun run agent --prompt "Analyze this code" --workspace ./src

# With JSON output
bun run agent --prompt "List files" --json
```

---

## Features Included

### 1. Security Hardening ✅
- **Command Validation**: Blocks dangerous commands (rm -rf, dd, sudo, etc.)
- **File Access Control**: Restricts access to workspace, blocks sensitive paths
- **Output Sanitization**: Automatically redacts API keys, tokens, secrets
- **Configuration**: Enable/disable via `~/.nanogent.json` or environment variables

### 2. Context Window Management ✅
- Dynamic context size management
- Context compaction when full
- Message tracking and statistics
- Generate summaries for single message removal

### 3. Parallel Tools & Cache ✅
- Parallel tool execution for read-only operations
- Advanced caching system with TTL
- Tool execution caching
- New tools: `search_and_view`, `edit_file_lines`

### 4. Self-Testing ✅
- 15 self-tests covering all core features
- Self-test script: `bun run self-test`
- CI workflows for automatic testing
- Self-review workflow for comprehensive verification

---

## Configuration

### Recommended Local Model

For optimal performance with local models:

```json
{
  "model": "Jackrong/Qwen3.5-4B-Claude-4.6-Opus-Reasoning-Distilled-GGUF",
  "baseURL": "http://127.0.0.1:1234/v1",
  "workspace": "/path/to/project"
}
```

### Security Configuration

```json
{
  "securityEnabled": true,
  "securityValidateCommands": true,
  "securityValidateFileAccess": true,
  "securitySanitizeOutput": true,
  "securityMaxFileSize": 10485760,
  "securityMaxBatchFiles": 50
}
```

---

## Testing

### Run All Tests

```bash
bun test
# Expected: 191 tests passing
```

### Run Security Tests

```bash
bun test src/security/index.test.ts
# Expected: 52 tests passing
```

### Run Self-Test

```bash
bun run self-test
# Expected: 15 tests passing
```

### Run Full CI

```bash
bun run ci
# Expected: All tests + self-test passing
```

---

## What's New in v1.1.0-alpha.1

### New Features
1. **Security Hardening**: Complete security system with command validation, file access control, and output sanitization
2. **Self-Testing**: 15 self-tests that the agent can run to verify its own functionality
3. **CI/CD Workflows**: GitHub Actions workflows for automatic testing and release
4. **Context Management**: Improved context window management with compaction
5. **Parallel Tools**: Parallel execution of read-only tools

### Improvements
1. All features merged into main branch
2. Simplified CI workflows for reliability
3. Comprehensive documentation
4. Model recommendation for optimal performance

### Bug Fixes
1. Fixed path matching for blocked files
2. Fixed command validation patterns
3. Fixed output sanitization for Bearer tokens

---

## Known Issues

1. **TypeScript Type Errors**: There are 8 pre-existing type errors that are allowed to fail in CI
   - These are not related to the new security features
   - Will be addressed in a future release

2. **Flaky Test**: The `git_diff` test may timeout occasionally
   - This is a timing issue, not a code issue
   - The test passes when run individually

---

## Troubleshooting

### Tests Failing

```bash
# Run tests locally to debug
bun test

# Run specific test file
bun test src/security/index.test.ts

# Run self-test
bun run self-test
```

### Build Issues

```bash
# Clean and rebuild
rm -rf dist node_modules
bun install
bun run build:all
```

### Missing Dependencies

```bash
# Install all dependencies
bun install
```

---

## Files

| File | Size | Description |
|------|------|-------------|
| `package.json` | 1.3 KB | Package metadata |
| `main.js` | 2.0 MB | Built main entry point |
| `opentui/index.js` | 2.0 MB | Built TUI entry point |
| `highlights-*.scm` | ~3-35 KB | Syntax highlighting themes |
| `tree-sitter-*.wasm` | ~400-1400 KB | Tree-sitter parsers |
| `nanoagent-1.1.0-alpha.1.tgz` | ~1.4 MB | Complete prerelease package |

---

## Version Information

- **Version**: 1.1.0-alpha.1
- **Branch**: main
- **Commit**: fc7bedc
- **Date**: June 20, 2026
- **Status**: Prerelease

---

## Repository

- **Main Repository**: https://github.com/leeno7786-coder/qwen-agent-tui
- **Documentation**: https://github.com/leeno7786-coder/qwen-agent-tui#readme
- **Issues**: https://github.com/leeno7786-coder/qwen-agent-tui/issues
- **Releases**: https://github.com/leeno7786-coder/qwen-agent-tui/releases

---

## License

MIT License - See LICENSE file in the repository

---

## Support

For questions or issues with this prerelease:

1. Check the documentation in the repository
2. Run the self-test to verify functionality
3. Open an issue on GitHub
4. Include the version (1.1.0-alpha.1) and your environment details

---

*Prerelease built on June 20, 2026*
