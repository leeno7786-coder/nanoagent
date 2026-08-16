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
import { useAppStore } from './app-store.js';

/**
 * App-side paste fallback. Native terminal paste (right-click, Ctrl+Shift+V)
 * is the reliable path and requires mouse capture OFF. This handler covers
 * Ctrl+V when a clipboard tool exists, and otherwise releases mouse capture
 * so the next paste can go through the terminal.
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
    if (renderer.useMouse) {
      renderer.useMouse = false;
      useAppStore.getState().setMouseEnabled(false);
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
