/**
 * OpenTUI uses hex colours.
 * These palettes are based on Tokyo Night with mappings for
 * the three themes the TUI supports.
 */

export interface Theme {
  name: string;
  userFg: string;
  agentFg: string;
  toolFg: string;
  errorFg: string;
  borderColor: string;
  statusIdle: string;
  statusThinking: string;
  statusTool: string;
  statusError: string;
  mutedFg: string;
  headerFg: string;
  inputFg: string;
  bgSelected: string;
  bgPanel: string;
  warningFg?: string;
  warningBorder?: string;
  accent?: string;
  successFg?: string;
}

export const THEMES: Record<string, Theme> = {
  dark: {
    name: 'dark',
    userFg: '#7dcfff',
    agentFg: '#9ece6a',
    toolFg: '#e0af68',
    errorFg: '#f7768e',
    borderColor: '#414868',
    statusIdle: '#9ece6a',
    statusThinking: '#e0af68',
    statusTool: '#7aa2f7',
    statusError: '#f7768e',
    mutedFg: '#565f89',
    headerFg: '#c0caf5',
    inputFg: '#7dcfff',
    bgSelected: '#24283b',
    bgPanel: '#16161e',
  },
  light: {
    name: 'light',
    userFg: '#2e7de9',
    agentFg: '#587539',
    toolFg: '#8f5e15',
    errorFg: '#f52a65',
    borderColor: '#a1a6c5',
    statusIdle: '#587539',
    statusThinking: '#8f5e15',
    statusTool: '#2e7de9',
    statusError: '#f52a65',
    mutedFg: '#8c8fa1',
    headerFg: '#3760bf',
    inputFg: '#2e7de9',
    bgSelected: '#d5d6db',
    bgPanel: '#e9e9ec',
  },
  highContrast: {
    name: 'highContrast',
    userFg: '#00ffff',
    agentFg: '#00ff00',
    toolFg: '#ffff00',
    errorFg: '#ff0000',
    borderColor: '#ffffff',
    statusIdle: '#00ff00',
    statusThinking: '#ffff00',
    statusTool: '#00aaff',
    statusError: '#ff0000',
    mutedFg: '#cccccc',
    headerFg: '#ffffff',
    inputFg: '#00ffff',
    bgSelected: '#333333',
    bgPanel: '#111111',
  },
};

export const DEFAULT_THEME = THEMES.dark;
