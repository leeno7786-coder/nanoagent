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
  /\|\s*(sudo\s+)?(sh|bash|zsh|dash|ash|powershell|pwsh|cmd)\b/i,
  /`\s*(sh|bash|dash|ash)\b/i,
  /\$\(\s*(sh|bash|dash|ash)\b/i,
  /\|\s*(sh\.exe|bash\.exe|python|python3|node)\b/i,
  /powershell\s+-enc\b/i,
  /iex\b/i,
  /invoke-expression\b/i,
  /downloadstring\b/i,
  /wget\b.*\|/i,
  /curl\b.*\|\s*(sh|bash)/i,
  /node\s+-e\b/i,
  /python\s+-c\b/i,

  // Windows-specific destructive
  /\bdel\s+\\\\/i,
  /\bdiskpart/i,
  /\breg\s+delete/i,
  /\breg\s+add/i,
  /\bnet\s+user\s+/i,
  /\bnet\s+localgroup\s+/i,
  /\bformat\s+[a-z]:/i,
  /\bcipher\s+\/w/i,
  /\bvssadmin\s+delete\s+shadows/i,
  /\bbcdedit/i,
];
