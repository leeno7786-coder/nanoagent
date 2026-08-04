/**
 * Dangerous command patterns that should be blocked.
 */
export const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  // System destruction
  /rm\s+-rf\s+\//i,
  /rm\s+--no-preserve-root/i,
  /rm\s+-r\s+\//i,
  /dd\s+if=\/dev\//i,
  /mkfs/i,
  /\bformat\s+[a-zA-Z]:/i,

  // Process management
  /kill\s+-9\s+1\b/i,
  /killall/i,

  // Privilege escalation
  /\bsudo\s+/i,
  /\bsu\s+-/i,
  /chmod\s+777\s+\//i,
  /chmod\s+-R\s+\//i,
  /chown\s+0:0\s+\//i,

  // Network listeners
  /\bnc\s+-l/i,
  /\bnetcat\s+-l/i,
  /\bssh\s+/i,
  /\bscp\s+/i,
  /\bsftp\s+/i,

  // File system overwrite to root
  />\s*\/dev\//i,
  />>\s*\/dev\//i,

  // Shell injection patterns
  /\|\s*(sudo\s+)?(sh|bash|zsh|powershell|pwsh|cmd)\b/i,
  /`\s*(sh|bash)\b/i,
  /\$\(\s*(sh|bash)\b/i,

  // Windows-specific destructive
  /\bdel\s+\\\\/i,
  /\bdiskpart/i,
  /\breg\s+delete/i,
  /\breg\s+add/i,
  /\bnet\s+user\s+/i,
  /\bnet\s+localgroup\s+/i,
];
