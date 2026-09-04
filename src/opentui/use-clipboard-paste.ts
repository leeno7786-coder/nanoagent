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
 * App-side paste fallback. The renderer never captures the mouse, so the
 * terminal's native paths (drag-select copy, right-click / Ctrl+Shift+V
 * paste) always work like a normal window. This handler additionally covers
 * Ctrl+V / Shift+Insert by reading the system clipboard directly when a
 * clipboard tool exists (wl-clipboard, xclip, xsel, clipboardy).
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
