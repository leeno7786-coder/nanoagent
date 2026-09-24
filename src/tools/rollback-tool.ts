import type { Tool } from './shared.js';
import { rollbackChanges } from '../workspace-history.js';

/** Lets the model undo its own edits from the touched-file history. */
export const rollbackChangesTool: Tool = {
  name: 'rollback_changes',
  description:
    'Undo your own file changes. path: restore one file. checkpoint: undo everything after that /snapshot checkpoint. Neither: undo all changes this session. Files you created are deleted.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to restore (workspace-relative)' },
      checkpoint: { type: 'string', description: 'Checkpoint name to roll back to' },
    },
  },
  execute: (args, ws) => {
    try {
      const path = typeof args.path === 'string' && args.path ? args.path : undefined;
      const checkpoint =
        typeof args.checkpoint === 'string' && args.checkpoint ? args.checkpoint : undefined;
      const result = rollbackChanges(ws, { path, checkpoint });
      return JSON.stringify({ ok: true, ...result });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: (err instanceof Error ? err.message : String(err)).replace(/^\[nanoagent\] /, ''),
      });
    }
  },
};
