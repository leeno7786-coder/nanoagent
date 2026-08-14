# Security Hardening

NanoAgent includes built-in security features to protect against common security risks when using AI agents with file system and command execution capabilities.

## Overview

The security system provides three main layers of protection:

1. **Command Validation** - Blocks dangerous shell commands
2. **File Access Control** - Restricts file system access to safe paths
3. **Output Sanitization** - Prevents sensitive data leakage in logs and responses

All security features are **enabled by default** and can be configured or disabled as needed.

---

## Trust Model

Anything shipped inside a cloned repository is **untrusted** — a malicious repo must not be
able to escalate privileges just by being opened in the agent:

- **Workspace `.env` files are untrusted.** Trust-sensitive variables —
  `NANOGENT_TRUST_PROJECT_MCP`, `QWEN_SECURITY_*`, `QWEN_BASE_URL`, `REMOTE_LMSTUDIO_URL`,
  and all `*_API_KEY` overrides — are only honored from the **real process environment**
  (or the trusted home-directory `.env`), never from a workspace/project `.env` loaded
  via dotenv. `getApiKey()` also reads only home-directory `.env` files.
  This prevents a repo from disabling security, redirecting the API or sub-agent
  endpoint (key/code exfiltration), or auto-trusting its own MCP servers.
- **MCP trust = exact global config paths.** Only the global config files directly in
  the home directory (`~/.nanogent.json`, `~/.nanoagent.json`, `~/.nanogent/config.json`,
  `~/.qwen-agent.json`) or an explicitly-passed config path are trusted to auto-connect
  MCP servers. A project config anywhere else — including repos cloned under `~/` — is
  treated as project-local and blocked from auto-connecting.
- **Configs merge, trust doesn't leak.** The global config is the base and the project
  config overrides it key-by-key. MCP server maps merge: global servers stay trusted
  and connect normally; servers that came from the project config are tracked
  (`mcpUntrusted`) and blocked individually.
- **Project-local MCP configs never auto-connect.** Trust = global `~/.nanogent.json`,
  an explicitly-passed config path, or `NANOGENT_TRUST_PROJECT_MCP=1` set in the real
  environment. (RCE guard — MCP servers are arbitrary local processes.)
- **Project-local skills are disabled by default.** Skills loaded from the workspace
  `skills/` directory (both `.json` and `SKILL.md`) start `enabled: false` and must be
  explicitly enabled, because skill prompts are injected into the system prompt.
  Home-directory/user-scope skills keep their previous defaults.
- **Explicit paths are trusted.** A config file passed explicitly by path is treated as
  user-approved, regardless of where it lives on disk.

---

## Configuration

Security settings can be configured via:

1. **Configuration file** (`~/.nanogent.json` or `~/.nanoagent.json`; legacy `~/.qwen-agent.json` is still read)
2. **Environment variables** (prefixed with `QWEN_SECURITY_`)
3. **Programmatically** via the `SecurityManager` API

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `securityEnabled` | boolean | `true` | Master switch for all security features |
| `securityValidateCommands` | boolean | `true` | Enable command validation |
| `securityValidateFileAccess` | boolean | `true` | Enable file access validation |
| `securitySanitizeOutput` | boolean | `true` | Enable output sanitization |
| `securityMaxFileSize` | number | `10485760` (10MB) | Maximum file size to read |
| `securityMaxBatchFiles` | number | `50` | Maximum files in batch operations |
| `securityAllowedPaths` | string[] | `[]` | Glob patterns for allowed paths |
| `securityBlockedPaths` | string[] | See defaults below | Glob patterns for blocked paths |

### Default Blocked Paths

The following paths are blocked by default (secrets, credentials, VCS internals,
and dependency lockfiles — project manifests like `package.json`, `go.mod`,
`requirements.txt`, and `tsconfig.json` stay readable/editable):

```
**/.env
**/.env.*
**/.git/**
**/.ssh/**
**/node_modules/**
**/secrets/**
**/credentials/**
**/*.pem
**/*.key
**/*.crt
**/*.cer
**/*.p12
**/*.pfx
**/id_rsa*
**/id_ed25519*
**/id_ecdsa*
**/known_hosts
**/authorized_keys
**/shadow
**/passwd
**/sudoers
**/hosts
**/resolv.conf
**/bun.lock
**/package-lock.json
**/yarn.lock
**/pnpm-lock.yaml
**/.npmrc
**/.yarnrc
**/bunfig.toml
**/composer.lock
**/Gemfile.lock
**/Cargo.lock
**/go.sum
**/Pipfile.lock
**/poetry.lock
```

### Example Configuration

**Via `~/.nanogent.json`:**

```json
{
  "securityEnabled": true,
  "securityValidateCommands": true,
  "securityValidateFileAccess": true,
  "securitySanitizeOutput": true,
  "securityMaxFileSize": 10485760,
  "securityMaxBatchFiles": 50,
  "securityAllowedPaths": ["**/config/**", "**/src/**"],
  "securityBlockedPaths": ["**/.env", "**/.git/**", "**/secrets/**"]
}
```

**Via Environment Variables:**

```bash
# Enable/disable security
export QWEN_SECURITY_ENABLED=true

# Validate commands
export QWEN_SECURITY_VALIDATE_COMMANDS=true

# Validate file access
export QWEN_SECURITY_VALIDATE_FILE_ACCESS=true

# Sanitize output
export QWEN_SECURITY_SANITIZE_OUTPUT=true

# Maximum file size (bytes)
export QWEN_SECURITY_MAX_FILE_SIZE=10485760

# Maximum batch files
export QWEN_SECURITY_MAX_BATCH_FILES=50
```

---

## Command Validation

### Blocked Commands

The following command patterns are **blocked by default**:

#### System Destruction
- `rm -rf` / `rm --no-preserve-root`
- `dd if=/dev/zero` / `dd if=/dev/urandom`
- `mkfs` / `mkfs.ext4` / `format`
- Any command writing to root directory (`/`, `C:\`, etc.)

#### Process Management
- `kill -9` / `pkill` / `killall` / `xkill`

#### Privilege Escalation
- `sudo` / `su`
- `chmod 777` / `chmod -R`
- `setuid` / `setgid`
- `chown 0:0`

#### Network Operations
- `nc` / `netcat`
- `curl -o /` / `wget -O /`
- `ssh` / `scp` / `sftp` / `telnet` / `ftp`

#### Shell Features
- Command chaining with `;`, `&&`, `||` followed by dangerous commands
- Command substitution with backticks or `$(...)`
- Piping to shell: `| sh`, `| bash`, `| zsh`, `| dash`

#### Code Execution
- `eval` / `exec` / `source`
- `python -c` / `py -c`
- `perl -e` / `ruby -e`
- `node -e` / `php -r`
- `javac` / `java -jar`

#### Package Managers
- `npm install -g` / `npm install --global`
- `yarn global add`
- `pnpm add -g`

#### Cron Jobs
- `crontab`
- `at` (scheduling commands)
- `batch` / `tasksch`

### Allowed Commands

Safe commands are **allowed by default**, including:

- Read-only commands: `ls`, `dir`, `pwd`, `cat`, `echo`, `date`, `whoami`
- Git operations: `git status`, `git diff`, `git log`, `git show`, etc.
- Build tools: `npm run`, `yarn`, `pnpm` (without global install)
- Development tools: `eslint`, `prettier`, `tsc`, `jest`, etc.

### Custom Command Patterns

Command validation is **default-allow**: any command that does not match a
dangerous pattern passes validation, and the PermissionManager mode
(`ask` by default) decides whether the user is prompted. You can extend the
blocked list by adding to the `DANGEROUS_COMMAND_PATTERNS` array in the
security module, or set a custom `allowedCommands` list to switch validation
to explicit allowlist enforcement.

---

## File Access Control

### Workspace Validation

All file operations are validated to ensure they stay within the configured workspace directory. Attempting to access paths outside the workspace will be blocked.

### Path Patterns

Path patterns use glob-style matching:

| Pattern | Matches |
|---------|---------|
| `**/.env` | Any `.env` file in any directory |
| `**/config/**` | Any file in any `config` directory |
| `src/**/*.ts` | All TypeScript files in `src` directory |
| `**/node_modules/**` | All files in any `node_modules` directory |

### Custom Path Configuration

**Allow specific paths:**

```json
{
  "securityAllowedPaths": ["**/config/**", "**/secrets/approved/**"]
}
```

**Block additional paths:**

```json
{
  "securityBlockedPaths": ["**/custom-blocked/**", "**/temp/**"]
}
```

> **Note:** Allowed paths take precedence over blocked paths. If a path matches both an allowed and blocked pattern, it will be **allowed**.

---

## Output Sanitization

### Sanitized Data Types

The following sensitive data is **automatically sanitized** from tool outputs and logs:

#### API Keys
- **OpenAI:** `sk-[a-zA-Z0-9]{20,}` → `[OPENAI_KEY_REDACTED]`
- **OpenRouter:** `or-[a-zA-Z0-9]{20,}` → `[OPENROUTER_KEY_REDACTED]`
- **Google:** `AIza[0-9A-Za-z\-_]{35}` → `[GOOGLE_KEY_REDACTED]`
- **AWS Access Keys:** `AKIA[0-9A-Z]{16}` → `[AWS_ACCESS_KEY_REDACTED]`
- **Generic API Keys:** Patterns matching `api_key=...`, `apikey=...`, etc.

#### Tokens
- **JWT Tokens:** `eyJ[...].eyJ[...].[...]` → `[JWT_REDACTED]`
- **Bearer Tokens:** `Bearer [token]` → `Bearer [REDACTED]`
- **Generic Tokens:** Patterns matching `token=...`, `auth: Bearer ...`, etc.

#### Secrets
- **Passwords:** Patterns matching `password=...`, `passwd=...`, etc.
- **Secrets:** Patterns matching `secret=...`, `api_secret=...`, etc.
- **Private Keys:** PEM format private keys → `[PRIVATE_KEY_REDACTED]`
- **SSH Keys:** `ssh-rsa [base64]` → `[SSH_KEY_REDACTED]`

#### Files
- **.env references:** `.env` → `.env[REDACTED]`

### Custom Sanitization

You can add custom sanitization patterns by extending the `SANITIZATION_PATTERNS` array in the security module.

---

## Programmatic Usage

### Using SecurityManager Directly

```typescript
import { createSecurityManager, globalSecurityManager } from './src/security/index';

// Create a security manager
const securityManager = createSecurityManager(
  {
    enabled: true,
    validateCommands: true,
    validateFileAccess: true,
    sanitizeOutput: true,
  },
  '/path/to/workspace'
);

// Validate a command
const commandResult = securityManager.validateCommand('ls -la');
if (commandResult.ok) {
  // Safe to execute
} else {
  console.error('Blocked:', commandResult.error);
}

// Validate file access
const fileResult = securityManager.validateFileAccess('/path/to/file.txt', 'read');
if (fileResult.ok) {
  // Safe to access
} else {
  console.error('Blocked:', fileResult.error);
}

// Sanitize output
const sanitized = securityManager.sanitizeOutput('API key: sk-abc123...');
console.log(sanitized); // "API key: [OPENAI_KEY_REDACTED]"
```

### Using the Global Instance

```typescript
import { globalSecurityManager } from './src/security/index';

// The global instance is already configured with defaults
const result = globalSecurityManager.validateCommand('rm -rf /');
// result.ok === false
```

---

## Security for Sub-Agents

Sub-agents (created via `explore_subagent`) **automatically inherit** the security configuration from the main agent. This ensures that:

- Sub-agents cannot execute dangerous commands
- Sub-agents cannot access blocked paths
- Sub-agent outputs are sanitized

The security manager is passed through the config object to sub-agents, so no additional configuration is needed.

---

## Disabling Security

> **⚠️ Warning:** Disabling security features reduces protection against potentially harmful operations. Only disable security if you fully understand the risks and have alternative protections in place.

### Disable All Security

```json
{
  "securityEnabled": false
}
```

Or via environment variable:
```bash
export QWEN_SECURITY_ENABLED=false
```

### Disable Specific Features

```json
{
  "securityEnabled": true,
  "securityValidateCommands": false,
  "securityValidateFileAccess": true,
  "securitySanitizeOutput": true
}
```

---

## Best Practices

### 1. Keep Security Enabled
Always keep security features enabled unless you have a specific reason to disable them.

### 2. Review Blocked Operations
If a legitimate operation is blocked, review why it was blocked and consider:
- Adding it to the allowed paths
- Adding a safe command pattern
- Adjusting your workflow to use safer alternatives

### 3. Regularly Update
Keep NanoAgent updated to receive the latest security improvements.

### 4. Report Security Issues
If you find a security vulnerability or a false positive/negative, please report it at:
🔗 [https://github.com/leeno7786-coder/nanoagent/issues](https://github.com/leeno7786-coder/nanoagent/issues)

### 5. Use Least Privilege
Configure the workspace to the minimum necessary directory. Avoid running the agent with access to sensitive system directories.

### 6. Review Agent Outputs
Even with sanitization, always review agent outputs before sharing them, especially in production environments.

---

## Troubleshooting

### Command Blocked as Dangerous

**Problem:** A legitimate command is being blocked.

**Solution:**
1. Check if the command matches any dangerous pattern
2. If you configured a custom `allowedCommands` list, add the command to it
   (a custom allow list switches validation to allowlist enforcement)
3. Or disable command validation for specific cases

### File Access Blocked

**Problem:** Access to a legitimate file is being blocked.

**Solution:**
1. Check if the path matches any blocked pattern
2. Add the path to `securityAllowedPaths`
3. Or remove it from `securityBlockedPaths`

### Output Not Sanitized

**Problem:** Sensitive data is appearing in output.

**Solution:**
1. Check if the data matches any sanitization pattern
2. Add a custom pattern to `SANITIZATION_PATTERNS`
3. Ensure `securitySanitizeOutput` is enabled

---

## Technical Details

### Security Check Order

1. **Command Validation**
   - Check against dangerous patterns → Block if matched
   - Check against custom blocked commands → Block if matched
   - Check against allowed commands (if specified) → Block if not matched
   - Default: Allow (the PermissionManager mode is the interactive gate)

2. **File Access Validation**
   - Check if path is within workspace → Block if outside
   - Check against allowed paths (if specified) → Block if not matched
   - Check against blocked paths → Block if matched
   - Default: Allow

3. **Output Sanitization**
   - Apply all sanitization patterns in order
   - Return sanitized output

### Performance

Security checks add minimal overhead:
- Command validation: ~1-2ms per command
- File access validation: ~1-2ms per path
- Output sanitization: ~1-5ms per output (depending on size)

The security system is designed to be fast and non-intrusive.

---

## License

The security hardening features are part of NanoAgent and are licensed under the same terms as the main project.

---

## Changelog

### v1.0.0 (Initial Release)
- Initial security hardening implementation
- Command validation with dangerous pattern blocking
- File access control with workspace validation
- Output sanitization for API keys and sensitive data
- Configuration via JSON and environment variables
- Integration with all tools and sub-agents
- Comprehensive test suite (52 tests)
