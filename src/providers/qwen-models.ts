import type { ModelInfo } from '../types.js';

/** Shared Qwen catalog for Alibaba Cloud Model Studio (intl + China). */
export const QWEN_CLOUD_MODELS: ModelInfo[] = [
  {
    id: 'qwen3.7-max',
    name: 'Qwen3.7 Max',
    description: 'Largest and most capable Qwen3.7 series model',
  },
  {
    id: 'qwen3.6-plus',
    name: 'Qwen3.6 Plus',
    description: 'Native vision-language with top-tier coding and OCR',
  },
  {
    id: 'qwen3.6-max',
    name: 'Qwen3.6 Max',
    description: 'Enhanced vibe coding and front-end skills',
  },
  {
    id: 'qwen3.6-27b',
    name: 'Qwen3.6 27B (Open)',
    description: 'Open-source hybrid vision-language model',
  },
  {
    id: 'qwen3.5-plus',
    name: 'Qwen3.5 Plus',
    description: 'Significant leap in text and multimodal capabilities',
  },
  {
    id: 'qwen3.5-27b',
    name: 'Qwen3.5 27B (Open)',
    description: 'Open-source hybrid MoE vision-language model',
  },
  {
    id: 'qwen3-max',
    name: 'Qwen3 Max',
    description: 'SOTA agent programming and tool invocation',
  },
  {
    id: 'qwen-plus',
    name: 'Qwen Plus',
    description: 'Enhanced super-large-scale language model',
  },
  {
    id: 'qwen3-coder-plus',
    name: 'Qwen3 Coder Plus',
    description: 'Strong coding agent with tool invocation',
  },
  {
    id: 'qwen3-coder-flash',
    name: 'Qwen3 Coder Flash',
    description: 'Fast coding-specialized model with multi-turn tool interaction',
    default: true,
  },
  {
    id: 'qwen3-coder-next',
    name: 'Qwen3 Coder Next (Open)',
    description: 'Open-source hybrid coding model',
  },
  {
    id: 'qwen3.6-flash',
    name: 'Qwen3.6 Flash',
    description: 'Fast vision-language with strong agentic coding',
  },
  {
    id: 'qwen3.5-flash',
    name: 'Qwen3.5 Flash',
    description: 'Cost-effective vision-language model',
  },
  {
    id: 'qwen-flash',
    name: 'Qwen Flash',
    description: '1M context, thinking/non-thinking modes',
  },
  {
    id: 'qwen-turbo',
    name: 'Qwen Turbo',
    description: 'Fast, cost-efficient model',
  },
  {
    id: 'qwen3-vl-plus',
    name: 'Qwen3 VL Plus',
    description: 'World-leading visual agent capabilities',
  },
  {
    id: 'qwen3-vl-flash',
    name: 'Qwen3 VL Flash',
    description: 'Fast small-scale visual understanding',
  },
];

/** Coding Plan catalogs — coding-focused subset. */
export const QWEN_CODING_MODELS: ModelInfo[] = [
  {
    id: 'qwen3-coder-plus',
    name: 'Qwen3 Coder Plus',
    description: 'Strong coding agent with tool invocation',
  },
  {
    id: 'qwen3-coder-flash',
    name: 'Qwen3 Coder Flash',
    description: 'Fast coding-specialized model',
    default: true,
  },
  {
    id: 'qwen3-coder-next',
    name: 'Qwen3 Coder Next (Open)',
    description: 'Open-source hybrid coding model',
  },
  {
    id: 'qwen3.5-plus',
    name: 'Qwen3.5 Plus',
    description: 'Flagship text and multimodal model',
  },
  {
    id: 'qwen3-max',
    name: 'Qwen3 Max',
    description: 'SOTA agent programming and tool invocation',
  },
  {
    id: 'qwen-plus',
    name: 'Qwen Plus',
    description: 'Enhanced super-large-scale language model',
  },
];
