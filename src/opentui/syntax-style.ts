import { SyntaxStyle, type ThemeTokenStyle } from '@opentui/core';
import { DEFAULT_THEME, type Theme } from './theme.js';

/**
 * Maps a Theme's syntax palette onto tree-sitter capture scopes.
 * Scopes are matched by prefix, so broad captures come first and
 * specific sub-scopes (e.g. string.escape) can override them.
 */
function buildTokenStyles(theme: Theme): ThemeTokenStyle[] {
  const s = theme.syntax;
  return [
    { scope: ['comment'], style: { foreground: s.comment, italic: true } },
    { scope: ['keyword'], style: { foreground: s.keyword } },
    { scope: ['string', 'string.special'], style: { foreground: s.string } },
    { scope: ['number', 'boolean', 'float'], style: { foreground: s.number } },
    { scope: ['function', 'function.call', 'function.method', 'method'], style: { foreground: s.function } },
    { scope: ['type', 'type.builtin', 'constructor'], style: { foreground: s.type } },
    { scope: ['variable', 'variable.parameter'], style: { foreground: s.variable } },
    { scope: ['variable.member', 'property', 'field'], style: { foreground: s.property } },
    { scope: ['operator'], style: { foreground: s.operator } },
    { scope: ['punctuation'], style: { foreground: s.punctuation } },
    { scope: ['constant', 'constant.builtin', 'variable.builtin'], style: { foreground: s.constant } },
    { scope: ['tag'], style: { foreground: s.tag } },
    { scope: ['attribute', 'label'], style: { foreground: s.attribute } },
  ];
}

const cache = new Map<string, SyntaxStyle>();

/**
 * Returns the SyntaxStyle for a theme, cached per theme name so switching
 * themes (F9 / /theme) picks up the right palette without rebuilding.
 */
export function getSyntaxStyle(theme: Theme = DEFAULT_THEME): SyntaxStyle {
  let style = cache.get(theme.name);
  if (!style) {
    style = SyntaxStyle.fromTheme(buildTokenStyles(theme));
    cache.set(theme.name, style);
  }
  return style;
}
