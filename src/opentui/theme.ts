/**
 * OpenTUI uses hex colours.
 *
 * The palettes aim for the clean, polished look of modern agent TUIs:
 * a muted, desaturated base with soft grey body text and a single warm
 * accent used sparingly for selections, tool labels and key hints.
 *
 * Token groups:
 *  - role colours (user / agent / tool / error)
 *  - status colours for the status bar state machine
 *  - surface colours (panels, selection bands, code backgrounds)
 *  - diff colours (tinted row backgrounds + sign colours)
 *  - syntax highlighting colours (consumed by syntax-style.ts)
 */

export interface SyntaxColors {
  keyword: string;
  string: string;
  comment: string;
  number: string;
  function: string;
  type: string;
  variable: string;
  operator: string;
  punctuation: string;
  property: string;
  constant: string;
  tag: string;
  attribute: string;
}

export interface Theme {
  name: string;

  // Role colours
  userFg: string;
  agentFg: string;
  toolFg: string;
  errorFg: string;

  // Status bar state colours
  statusIdle: string;
  statusThinking: string;
  statusTool: string;
  statusError: string;

  // Surfaces and text
  borderColor: string;
  mutedFg: string;
  headerFg: string;
  inputFg: string;
  bgSelected: string;
  bgPanel: string;

  // Accent + semantics
  accent: string;
  successFg: string;
  warningFg: string;
  warningBorder: string;

  // Strong selection (solid accent bar, e.g. command palette row)
  accentBg: string;
  onAccentFg: string;

  // Code + diff surfaces
  codeBg: string;
  diffAddBg: string;
  diffRemoveBg: string;
  diffAddSignFg: string;
  diffRemoveSignFg: string;

  // Syntax highlighting
  syntax: SyntaxColors;
}

const dark: Theme = {
  name: 'dark',

  userFg: '#b8c2d8',
  agentFg: '#a8c69b',
  toolFg: '#d9a05b',
  errorFg: '#e0808a',

  statusIdle: '#a8c69b',
  statusThinking: '#d9a05b',
  statusTool: '#8fb0d8',
  statusError: '#e0808a',

  borderColor: '#363a44',
  mutedFg: '#6e7380',
  headerFg: '#d6dae3',
  inputFg: '#b8c2d8',
  bgSelected: '#33363f',
  bgPanel: '#1a1c22',

  accent: '#d9a05b',
  successFg: '#a8c69b',
  warningFg: '#d8b45c',
  warningBorder: '#7a6338',

  accentBg: '#d9a05b',
  onAccentFg: '#1a1c22',

  codeBg: '#15171c',
  diffAddBg: '#26392c',
  diffRemoveBg: '#402a2e',
  diffAddSignFg: '#a8c69b',
  diffRemoveSignFg: '#e0808a',

  syntax: {
    keyword: '#b494bd',
    string: '#a8c69b',
    comment: '#6e7380',
    number: '#d9a05b',
    function: '#8fb0d8',
    type: '#d3b887',
    variable: '#d6dae3',
    operator: '#9aa1ad',
    punctuation: '#7d828e',
    property: '#9db8c9',
    constant: '#d9a05b',
    tag: '#c58f92',
    attribute: '#d3b887',
  },
};

const light: Theme = {
  name: 'light',

  userFg: '#4d6a9a',
  agentFg: '#5d7b4e',
  toolFg: '#97682e',
  errorFg: '#c04856',

  statusIdle: '#5d7b4e',
  statusThinking: '#97682e',
  statusTool: '#4d6a9a',
  statusError: '#c04856',

  borderColor: '#cdcdd4',
  mutedFg: '#8b8e97',
  headerFg: '#33363d',
  inputFg: '#4d6a9a',
  bgSelected: '#e0ddd4',
  bgPanel: '#f0ede6',

  accent: '#97682e',
  successFg: '#5d7b4e',
  warningFg: '#8f6b1d',
  warningBorder: '#c2a264',

  accentBg: '#97682e',
  onAccentFg: '#faf8f2',

  codeBg: '#e8e5dd',
  diffAddBg: '#dde7d7',
  diffRemoveBg: '#eed9da',
  diffAddSignFg: '#4e7a45',
  diffRemoveSignFg: '#b04a55',

  syntax: {
    keyword: '#8a5a8f',
    string: '#5d7b4e',
    comment: '#8b8e97',
    number: '#97682e',
    function: '#4d6a9a',
    type: '#8a6d3b',
    variable: '#33363d',
    operator: '#6b6e77',
    punctuation: '#9a9da6',
    property: '#4d7a8a',
    constant: '#97682e',
    tag: '#a04a50',
    attribute: '#8a6d3b',
  },
};

const highContrast: Theme = {
  name: 'highContrast',

  userFg: '#00ffff',
  agentFg: '#00ff00',
  toolFg: '#ffff00',
  errorFg: '#ff0000',

  statusIdle: '#00ff00',
  statusThinking: '#ffff00',
  statusTool: '#00aaff',
  statusError: '#ff0000',

  borderColor: '#ffffff',
  mutedFg: '#cccccc',
  headerFg: '#ffffff',
  inputFg: '#00ffff',
  bgSelected: '#333333',
  bgPanel: '#111111',

  accent: '#ffff00',
  successFg: '#00ff00',
  warningFg: '#ffff00',
  warningBorder: '#ffff00',

  accentBg: '#ffff00',
  onAccentFg: '#000000',

  codeBg: '#000000',
  diffAddBg: '#003300',
  diffRemoveBg: '#330000',
  diffAddSignFg: '#00ff00',
  diffRemoveSignFg: '#ff0000',

  syntax: {
    keyword: '#ff00ff',
    string: '#00ff00',
    comment: '#cccccc',
    number: '#ffff00',
    function: '#00ffff',
    type: '#ffff00',
    variable: '#ffffff',
    operator: '#ffffff',
    punctuation: '#cccccc',
    property: '#00ffff',
    constant: '#ffff00',
    tag: '#ff0000',
    attribute: '#ffff00',
  },
};

const warmDark: Theme = {
  name: 'warmDark',

  userFg: '#b3bfd2',
  agentFg: '#b3c295',
  toolFg: '#e0a370',
  errorFg: '#e0847f',

  statusIdle: '#b3c295',
  statusThinking: '#e0a370',
  statusTool: '#a3b8cc',
  statusError: '#e0847f',

  borderColor: '#453f38',
  mutedFg: '#7d766b',
  headerFg: '#ddd6cb',
  inputFg: '#b3bfd2',
  bgSelected: '#3a352e',
  bgPanel: '#1e1a16',

  accent: '#e0a370',
  successFg: '#b3c295',
  warningFg: '#dbb068',
  warningBorder: '#7d6140',

  accentBg: '#e0a370',
  onAccentFg: '#1e1a16',

  codeBg: '#181410',
  diffAddBg: '#2f3a26',
  diffRemoveBg: '#422a26',
  diffAddSignFg: '#b3c295',
  diffRemoveSignFg: '#e0847f',

  syntax: {
    keyword: '#c39bb0',
    string: '#b3c295',
    comment: '#7d766b',
    number: '#e0a370',
    function: '#a3b8cc',
    type: '#d6b285',
    variable: '#ddd6cb',
    operator: '#a39a8d',
    punctuation: '#847d72',
    property: '#9fb8b2',
    constant: '#e0a370',
    tag: '#cf9489',
    attribute: '#d6b285',
  },
};

const coolDark: Theme = {
  name: 'coolDark',

  userFg: '#a8b8d0',
  agentFg: '#93bdab',
  toolFg: '#7aa2c9',
  errorFg: '#d9838e',

  statusIdle: '#93bdab',
  statusThinking: '#8fb8d9',
  statusTool: '#7fb5b8',
  statusError: '#d9838e',

  borderColor: '#323a46',
  mutedFg: '#6a7382',
  headerFg: '#d3dae6',
  inputFg: '#a8b8d0',
  bgSelected: '#2e3542',
  bgPanel: '#161a20',

  accent: '#7aa2c9',
  successFg: '#93bdab',
  warningFg: '#cfb36b',
  warningBorder: '#6f5f3a',

  accentBg: '#7aa2c9',
  onAccentFg: '#161a20',

  codeBg: '#12151a',
  diffAddBg: '#1f3328',
  diffRemoveBg: '#38262c',
  diffAddSignFg: '#93bdab',
  diffRemoveSignFg: '#d9838e',

  syntax: {
    keyword: '#a3a0c4',
    string: '#8fbcae',
    comment: '#66707e',
    number: '#a89cc8',
    function: '#8fa8c8',
    type: '#8fadb8',
    variable: '#d3dae6',
    operator: '#95a0ae',
    punctuation: '#78818e',
    property: '#94b3c4',
    constant: '#a89cc8',
    tag: '#bf8d94',
    attribute: '#8fadb8',
  },
};

const black: Theme = {
  name: 'black',

  userFg: '#b8c2d8',
  agentFg: '#a8c69b',
  toolFg: '#d9a05b',
  errorFg: '#e0808a',

  statusIdle: '#a8c69b',
  statusThinking: '#d9a05b',
  statusTool: '#8fb0d8',
  statusError: '#e0808a',

  borderColor: '#2a2a2a',
  mutedFg: '#6e7380',
  headerFg: '#d6dae3',
  inputFg: '#b8c2d8',
  bgSelected: '#1a1a1a',
  bgPanel: '#000000',

  accent: '#d9a05b',
  successFg: '#a8c69b',
  warningFg: '#d8b45c',
  warningBorder: '#7a6338',

  accentBg: '#d9a05b',
  onAccentFg: '#000000',

  codeBg: '#0a0a0a',
  diffAddBg: '#2c4534',
  diffRemoveBg: '#4d2f34',
  diffAddSignFg: '#a8c69b',
  diffRemoveSignFg: '#e0808a',

  syntax: {
    keyword: '#b494bd',
    string: '#a8c69b',
    comment: '#6e7380',
    number: '#d9a05b',
    function: '#8fb0d8',
    type: '#d3b887',
    variable: '#d6dae3',
    operator: '#9aa1ad',
    punctuation: '#7d828e',
    property: '#9db8c9',
    constant: '#d9a05b',
    tag: '#c58f92',
    attribute: '#d3b887',
  },
};

export const THEMES: Record<string, Theme> = {
  dark,
  light,
  warmDark,
  highContrast,
  coolDark,
  black,
};

export const DEFAULT_THEME = THEMES.dark;
