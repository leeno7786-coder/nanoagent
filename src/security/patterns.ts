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

/**
 * Safe command patterns that are always allowed.
 */
export const SAFE_COMMAND_PATTERNS: RegExp[] = [
  /^git\s+status(?:\s+.*)?$/i,
  /^git\s+diff(?:\s+.*)?$/i,
  /^git\s+log(?:\s+.*)?$/i,
  /^git\s+branch(?:\s+.*)?$/i,
  /^git\s+checkout(?:\s+.*)?$/i,
  /^git\s+pull(?:\s+.*)?$/i,
  /^git\s+push(?:\s+.*)?$/i,
  /^git\s+fetch(?:\s+.*)?$/i,
  /^git\s+add(?:\s+.*)?$/i,
  /^git\s+commit(?:\s+.*)?$/i,
  /^git\s+stash(?:\s+.*)?$/i,
  /^git\s+reset$/i,
  /^git\s+reset\s+--/i,

  // File operations
  /^ls(?:\s+.*)?$/i,
  /^dir(?:\s+.*)?$/i,
  /^pwd$/i,
  /^cd(?:\s+.*)?$/i,
  /^cat(?:\s+.*)?$/i,
  /^type(?:\s+.*)?$/i,
  /^more(?:\s+.*)?$/i,
  /^less(?:\s+.*)?$/i,
  /^head(?:\s+.*)?$/i,
  /^tail(?:\s+.*)?$/i,
  /^wc(?:\s+.*)?$/i,
  /^find(?:\s+(?!.*\s-exec)(?!.*\s-delete).*)?$/i,
  /^grep(?:\s+.*)?$/i,
  /^sort$/i,
  /^uniq$/i,
  /^awk$/i,
  /^sed$/i,
  /^cut$/i,
  /^tr$/i,
  /^echo$/i,
  /^echo\s+\S+/i,
  /^date$/i,
  /^whoami$/i,
  /^uname$/i,
  /^hostname$/i,
  /^which$/i,
  /^which\s+\S+/i,
  /^where$/i,
  /^where\s+\S+/i,

  // Node.js/Bun operations
  /^node\s+--version$/i,
  /^bun\s+--version$/i,
  /^npm\s+--version$/i,
  /^npm\s+test$/i,
  /^npm\s+run\s+\S+/i,
  /^bun\s+test$/i,
  /^bun\s+run\s+\S+/i,

  // Python/uv operations
  /^python(?:\s+(?!-c\b)(?!-m\b).*)?$/i,
  /^python3(?:\s+(?!-c\b)(?!-m\b).*)?$/i,
  /^pytest(?:\s+.*)?$/i,
  /^pip(?:\s+.*)?$/i,
  /^uv(?:\s+.*)?$/i,
  /^uvx(?:\s+.*)?$/i,

  // Network & downloads
  /^curl(?:\s+.*)?$/i,
  /^wget(?:\s+.*)?$/i,
  /^git\s+clone(?:\s+.*)?$/i,
  /^docker(?:\s+(?!run\b)(?!exec\b).*)?$/i,
  /^huggingface-cli(?:\s+.*)?$/i,

  // Build tools
  /^make$/i,
  /^make\s+\S+/i,
  /^cmake$/i,
  /^cmake\s+\S+/i,
  /^cargo$/i,
  /^cargo\s+\S+/i,
  /^go\s+build$/i,
  /^go\s+test$/i,
  /^go\s+run$/i,

  // Text editors
  /^vim$/i,
  /^nano$/i,
  /^emacs$/i,
  /^code$/i,
  /^notepad$/i,

  // Version control
  /^hg$/i,
  /^hg\s+\S+/i,
  /^svn$/i,
  /^svn\s+\S+/i,
];
