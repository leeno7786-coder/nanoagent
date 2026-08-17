import { afterEach, describe, expect, it } from 'bun:test';
import { applyEffortFromEnvAndDefault } from './effort.js';
import type { Config } from '../types.js';

const saved = process.env.QWEN_EFFORT;

afterEach(() => {
  if (saved === undefined) delete process.env.QWEN_EFFORT;
  else process.env.QWEN_EFFORT = saved;
});

describe('applyEffortFromEnvAndDefault', () => {
  it('defaults to low', () => {
    delete process.env.QWEN_EFFORT;
    const cfg = { effort: undefined } as Pick<Config, 'effort'>;
    applyEffortFromEnvAndDefault(cfg);
    expect(cfg.effort).toBe('low');
  });

  it('uses env when unset in file', () => {
    process.env.QWEN_EFFORT = 'xhigh';
    const cfg = { effort: undefined } as Pick<Config, 'effort'>;
    applyEffortFromEnvAndDefault(cfg);
    expect(cfg.effort).toBe('extra-high');
  });

  it('file wins over env', () => {
    process.env.QWEN_EFFORT = 'high';
    const cfg = { effort: 'none' } as Pick<Config, 'effort'>;
    applyEffortFromEnvAndDefault(cfg);
    expect(cfg.effort).toBe('none');
  });

  it('ignores invalid env', () => {
    process.env.QWEN_EFFORT = 'max';
    const cfg = { effort: undefined } as Pick<Config, 'effort'>;
    applyEffortFromEnvAndDefault(cfg);
    expect(cfg.effort).toBe('low');
  });
});
