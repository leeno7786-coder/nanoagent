import { useEffect, useRef } from 'react';
import { useKeyboard, useRenderer } from '@opentui/react';
import type { MouseEvent } from '@opentui/core';
import {
  isPasteMouseButton,
  isPasteShortcut,
  pasteIntoTarget,
  readClipboardText,
  type PasteMode,
} from '../clipboard.js';

/**
 * App-side paste handling. Mouse capture is ON (for wheel scroll), so
 * right-click / middle-click reach this handler instead of the terminal —
 * we read the system clipboard directly (wl-paste, xclip, xsel, clipboardy)
 * and insert into the focused editor. Ctrl+V / Shift+Insert work the same
 * way. Native selection copy stays available via Shift+drag, which
 * bypasses app mouse capture in most terminals.
 */
export function useClipboardPaste(mode: PasteMode = 'insert'): void {
  const renderer = useRenderer();
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const applyClipboard = () => {
    const text = readClipboardText();
    const editor = renderer.currentFocusedEditor;
    if (text && editor && pasteIntoTarget(editor, text, modeRef.current)) {
      return true;
    }
    return false;
  };

  const applyRef = useRef(applyClipboard);
  applyRef.current = applyClipboard;

  useKeyboard((keyEvent) => {
    if (!isPasteShortcut(keyEvent)) return;
    if (!applyRef.current()) return;
    keyEvent.preventDefault?.();
    keyEvent.stopPropagation?.();
  });

  useEffect(() => {
    const root = renderer.root;
    const onDown = (event: MouseEvent) => {
      if (!isPasteMouseButton(event.button)) return;
      if (!applyRef.current()) return;
      event.preventDefault();
      event.stopPropagation();
    };
    root.onMouseDown = onDown;
    return () => {
      root.onMouseDown = undefined as unknown as typeof onDown;
    };
  }, [renderer]);
}
