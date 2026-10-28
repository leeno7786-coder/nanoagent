import { describe, expect, it } from 'bun:test';
import type { Config } from '../types.js';
import type { ChatMessage } from './types.js';
import {
  buildChatCompletionsParams,
  shouldSendThinkingExtra,
  shouldSendPromptCacheKey,
  promptCacheKeyFor,
} from './request.js';

function cfg(extra: Partial<Config> = {}): Config {
  return {
    model: 'qwen3.5-4b',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: 'k',
    workspace: '/tmp/ws',
    retryCount: 0,
    ...extra,
  } as Config;
}

const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
const tools = [{ type: 'function', function: { name: 'read_file', parameters: {} } }];

describe('shouldSendThinkingExtra', () => {
  it('keeps qwen/bonsai enable_thinking when the catalog is unknown', () => {
    expect(shouldSendThinkingExtra(cfg({ model: 'qwen3.5-4b' }))).toBe(true);
    expect(shouldSendThinkingExtra(cfg({ model: 'Bonsai-8B' }))).toBe(true);
    expect(shouldSendThinkingExtra(cfg({ model: 'gpt-4o' }))).toBe(false);
  });

  it('omits thinking extras when the catalog is explicit false', () => {
    expect(shouldSendThinkingExtra(cfg({ model: 'qwen3.5-4b', supportsThinking: false }))).toBe(
      false
    );
  });
});

describe('shouldSendPromptCacheKey', () => {
  it('skips local providers even when the catalog says cache is supported', () => {
    expect(
      shouldSendPromptCacheKey(
        cfg({
          baseURL: 'http://127.0.0.1:1234/v1',
          supportsPromptCache: true,
        })
      )
    ).toBe(false);
  });

  it('sends only when the catalog is explicit true on a non-OpenRouter cloud endpoint', () => {
    const other = 'https://api.deepseek.com/v1';
    expect(shouldSendPromptCacheKey(cfg({ supportsPromptCache: true, baseURL: other }))).toBe(true);
    expect(shouldSendPromptCacheKey(cfg({ baseURL: other }))).toBe(false);
  });

  it('sends on OpenRouter even when the catalog is unknown (sticky routing key)', () => {
    expect(shouldSendPromptCacheKey(cfg({}))).toBe(true);
    expect(shouldSendPromptCacheKey(cfg({ model: 'anthropic/claude-sonnet-4.6' }))).toBe(true);
  });

  it('honors promptCache / QWEN_PROMPT_CACHE opt-out', () => {
    expect(shouldSendPromptCacheKey(cfg({ supportsPromptCache: true, promptCache: false }))).toBe(
      false
    );
  });
});

describe('buildChatCompletionsParams', () => {
  it('omits enable_thinking for qwen when catalog says no thinking', () => {
    const body = buildChatCompletionsParams(
      cfg({ model: 'qwen3.5-4b', supportsThinking: false }),
      messages,
      tools
    );
    expect(body.enable_thinking).toBeUndefined();
    expect(body.tools).toEqual(tools);
  });

  it('still sends tools when the catalog says no tools', () => {
    const body = buildChatCompletionsParams(cfg({ supportsTools: false }), messages, tools);
    expect(body.tools).toEqual(tools);
  });

  it('adds prompt_cache_key on cloud when catalog supports cache', () => {
    const c = cfg({ supportsPromptCache: true, workspace: '/tmp/ws', model: 'gpt-4o' });
    const body = buildChatCompletionsParams(c, messages);
    expect(body.prompt_cache_key).toBe(promptCacheKeyFor(c));
    expect(typeof body.prompt_cache_key).toBe('string');
    expect(String(body.prompt_cache_key).startsWith('na-')).toBe(true);
  });

  it('does not add prompt_cache_key for local models', () => {
    const body = buildChatCompletionsParams(
      cfg({
        baseURL: 'http://127.0.0.1:1234/v1',
        supportsPromptCache: true,
        model: 'qwen3.5-4b',
      }),
      messages
    );
    expect(body.prompt_cache_key).toBeUndefined();
  });

  it('does not add prompt_cache_key when opted out', () => {
    const body = buildChatCompletionsParams(
      cfg({ supportsPromptCache: true, promptCache: false }),
      messages
    );
    expect(body.prompt_cache_key).toBeUndefined();
  });

  it('does not add prompt_cache_key on a cloud endpoint that does not use it', () => {
    const body = buildChatCompletionsParams(
      cfg({ model: 'gpt-4o', baseURL: 'https://api.deepseek.com/v1' }),
      messages
    );
    expect(body.prompt_cache_key).toBeUndefined();
  });

  it('marks the last cacheable message with cache_control for Anthropic on OpenRouter', () => {
    const body = buildChatCompletionsParams(cfg({ model: 'anthropic/claude-sonnet-4.6' }), [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: [] },
      { role: 'tool', content: '{"ok":true}', tool_call_id: 'c1' },
      { role: 'user', content: 'go' },
    ]);
    const rows = body.messages as Array<Record<string, unknown>>;
    // Tool rows are skipped — providers map them to tool_result blocks where
    // the marker is not reliably forwarded — so the breakpoint lands on the
    // last message before it.
    expect(rows[3]!.content).toBe('{"ok":true}');
    expect(rows[4]!.content).toEqual([
      { type: 'text', text: 'go', cache_control: { type: 'ephemeral' } },
    ]);
    expect(rows[0]!.content).toBe('sys');
  });

  it('leaves implicit-caching providers alone (no cache_control on OpenAI/DeepSeek)', () => {
    expect(buildChatCompletionsParams(cfg({ model: 'openai/gpt-5.2' }), messages).messages).toEqual(
      [{ role: 'user', content: 'hi' }]
    );
    expect(
      buildChatCompletionsParams(cfg({ model: 'deepseek/deepseek-v3.2' }), messages).messages
    ).toEqual([{ role: 'user', content: 'hi' }]);
    // Not an OpenRouter endpoint, and local endpoints never send cache extras.
    expect(
      buildChatCompletionsParams(
        cfg({ model: 'anthropic/claude-sonnet-4.6', baseURL: 'https://api.anthropic.com/v1' }),
        messages
      ).messages
    ).toEqual([{ role: 'user', content: 'hi' }]);
    expect(
      buildChatCompletionsParams(
        cfg({
          model: 'anthropic/claude-sonnet-4.6',
          baseURL: 'http://127.0.0.1:1234/v1',
        }),
        messages
      ).messages
    ).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('honors the promptCache opt-out for cache_control too', () => {
    const body = buildChatCompletionsParams(
      cfg({ model: 'anthropic/claude-sonnet-4.6', promptCache: false }),
      messages
    );
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('keeps enable_thinking for qwen when capabilities are unknown', () => {
    const body = buildChatCompletionsParams(cfg({ model: 'qwen3.5-4b' }), messages);
    expect(body.enable_thinking).toBe(true);
  });

  it('sends max_tokens and temperature for classic chat models', () => {
    const body = buildChatCompletionsParams(
      cfg({
        model: 'gpt-4o',
        maxTokens: 4096,
        temperature: 0.2,
        baseURL: 'https://api.openai.com/v1',
      }),
      messages
    );
    expect(body.max_tokens).toBe(4096);
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.temperature).toBe(0.2);
  });

  it('honors a per-call maxTokens override for compaction summaries', () => {
    const body = buildChatCompletionsParams(
      cfg({
        model: 'gpt-4o',
        maxTokens: 4096,
        baseURL: 'https://api.openai.com/v1',
      }),
      messages,
      undefined,
      { maxTokens: 20000 }
    );
    expect(body.max_tokens).toBe(20000);
  });

  it('sends max_completion_tokens and omits sampling params for Azure GPT-5.6 Luna', () => {
    const body = buildChatCompletionsParams(
      cfg({
        model: 'gpt-5.6-luna',
        maxTokens: 4096,
        temperature: 0.2,
        baseURL: 'https://myres.openai.azure.com/openai/v1',
      }),
      messages
    );
    expect(body.max_completion_tokens).toBe(4096);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  it('uses the completion-token param for o-series and prefixed GPT-5 ids', () => {
    for (const model of ['o3-mini', 'openai/gpt-5', 'gpt-5.1']) {
      const body = buildChatCompletionsParams(cfg({ model, maxTokens: 2048 }), messages);
      expect(body.max_completion_tokens).toBe(2048);
      expect(body.max_tokens).toBeUndefined();
      expect(body.temperature).toBeUndefined();
    }
  });
});

describe('buildChatCompletionsParams effort', () => {
  it('omits thinking extras when effort is none even for qwen', () => {
    const body = buildChatCompletionsParams(cfg({ model: 'qwen3.5-4b', effort: 'none' }), messages);
    expect(body.enable_thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('sends enable_thinking for qwen at low when catalog is unknown', () => {
    const body = buildChatCompletionsParams(cfg({ model: 'qwen3.5-4b', effort: 'low' }), messages);
    expect(body.enable_thinking).toBe(true);
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('sends enable_thinking for a non-qwen model when the catalog supports thinking', () => {
    const body = buildChatCompletionsParams(
      cfg({ model: 'openai/gpt-5', effort: 'low', supportsThinking: true }),
      messages
    );
    expect(body.enable_thinking).toBe(true);
  });

  it('sends reasoning_effort xhigh when catalog supports it', () => {
    const body = buildChatCompletionsParams(
      cfg({
        model: 'openai/gpt-5',
        effort: 'extra-high',
        supportsReasoningEffort: true,
        supportsThinking: true,
      }),
      messages
    );
    expect(body.reasoning_effort).toBe('xhigh');
    expect(body.enable_thinking).toBe(true);
  });

  it('sends reasoning_effort on local endpoints so /effort actually applies', () => {
    const body = buildChatCompletionsParams(
      cfg({
        model: 'qwen3.5-4b',
        baseURL: 'http://127.0.0.1:1234/v1',
        effort: 'high',
        supportsReasoningEffort: true,
      }),
      messages
    );
    expect(body.reasoning_effort).toBe('high');
    expect(body.enable_thinking).toBe(true);
  });

  it('omits extras when supportsThinking is false', () => {
    const body = buildChatCompletionsParams(
      cfg({
        model: 'qwen3.5-4b',
        effort: 'high',
        supportsThinking: false,
        supportsReasoningEffort: true,
      }),
      messages
    );
    expect(body.enable_thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('sends reasoning_effort none when catalog lists the field and effort is none', () => {
    const body = buildChatCompletionsParams(
      cfg({
        model: 'openai/gpt-5',
        effort: 'none',
        supportsReasoningEffort: true,
        supportsThinking: true,
      }),
      messages
    );
    expect(body.enable_thinking).toBeUndefined();
    expect(body.reasoning_effort).toBe('none');
  });
});

describe('buildChatCompletionsParams local reasoning', () => {
  it('sends reasoning_effort on local LM Studio so /effort actually applies', () => {
    const body = buildChatCompletionsParams(
      cfg({
        model: 'qwen3.5-4b',
        baseURL: 'http://127.0.0.1:1234/v1',
        effort: 'high',
      }),
      messages
    );
    expect(body.reasoning_effort).toBe('high');
    expect(body.enable_thinking).toBe(true);
  });

  it('defaults the thinking budget for small local models', () => {
    const body = buildChatCompletionsParams(
      cfg({
        model: 'qwen3.5-4b',
        baseURL: 'http://127.0.0.1:1234/v1',
        smallModelMode: true,
      }),
      messages
    );
    expect(body.reasoning_budget_tokens).toBe(2048);
  });

  it('skips the default budget when smallModelMode is false', () => {
    const body = buildChatCompletionsParams(
      cfg({
        model: 'qwen3.5-4b',
        baseURL: 'http://127.0.0.1:1234/v1',
        smallModelMode: false,
      }),
      messages
    );
    expect(body.reasoning_budget_tokens).toBeUndefined();
  });

  it('honors an explicit cfg.reasoningBudget override', () => {
    const body = buildChatCompletionsParams(
      cfg({
        model: 'qwen3.5-4b',
        baseURL: 'http://127.0.0.1:1234/v1',
        reasoningBudget: 512,
      }),
      messages
    );
    expect(body.reasoning_budget_tokens).toBe(512);
  });

  it('omits local thinking extras when reasoningBudget is zero', () => {
    const body = buildChatCompletionsParams(
      cfg({
        model: 'qwen3.5-4b',
        baseURL: 'http://127.0.0.1:1234/v1',
        reasoningBudget: 0,
      }),
      messages
    );
    expect(body.enable_thinking).toBeUndefined();
    expect(body.reasoning_budget_tokens).toBeUndefined();
    // reasoning_effort 'none' alone is a silent no-op on Qwen3.5 templates
    // under LM Studio — the template reads enable_thinking, so the portable
    // switch has to ride along.
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('sends the portable thinking-off switch when local effort is none', () => {
    const body = buildChatCompletionsParams(
      cfg({
        model: 'qwen3.5-4b',
        baseURL: 'http://127.0.0.1:1234/v1',
        effort: 'none',
      }),
      messages
    );
    expect(body.enable_thinking).toBeUndefined();
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.reasoning_effort).toBe('none');
  });

  it('lets a per-call options.reasoningBudgetTokens override win over cfg', () => {
    const body = buildChatCompletionsParams(
      cfg({
        model: 'qwen3.5-4b',
        baseURL: 'http://127.0.0.1:1234/v1',
        reasoningBudget: 4096,
      }),
      messages,
      undefined,
      { reasoningBudgetTokens: 128 }
    );
    expect(body.reasoning_budget_tokens).toBe(128);
  });

  it('forwards reasoning_effort=none when thinking is explicitly disabled (escalation retry)', () => {
    const body = buildChatCompletionsParams(
      cfg({
        model: 'qwen3.5-4b',
        baseURL: 'http://127.0.0.1:1234/v1',
        effort: 'high',
      }),
      messages,
      undefined,
      { enableThinking: false }
    );
    expect(body.enable_thinking).toBeUndefined();
    expect(body.reasoning_effort).toBe('none');
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('does not send the budget on cloud endpoints', () => {
    const body = buildChatCompletionsParams(
      cfg({
        model: 'qwen3.5-4b',
        baseURL: 'https://openrouter.ai/api/v1',
        supportsReasoningEffort: true,
        supportsThinking: true,
        effort: 'high',
        reasoningBudget: 1024,
      }),
      messages
    );
    expect(body.reasoning_budget_tokens).toBeUndefined();
  });

  it('cloud force-thinking-off sends reasoning_effort=none even when effort is set', () => {
    // The reasoning-only loop retry passes `enableThinking: false` so the
    // call no longer spends the output budget on a thinking block, even
    // though cfg.effort would otherwise send 'low' to a model that
    // supports the field.
    const body = buildChatCompletionsParams(
      cfg({
        model: 'openai/gpt-5',
        baseURL: 'https://openrouter.ai/api/v1',
        effort: 'low',
        supportsReasoningEffort: true,
        supportsThinking: true,
      }),
      messages,
      undefined,
      { enableThinking: false }
    );
    expect(body.enable_thinking).toBeUndefined();
    expect(body.reasoning_effort).toBe('none');
  });
});
