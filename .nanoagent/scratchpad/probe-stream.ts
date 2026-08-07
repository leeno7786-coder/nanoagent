/** Time-to-first-chunk probe: replicate the worker's streaming request shape. */
const modelId = process.argv[2];
const withTools = process.argv[3] === 'tools';

const tools = withTools
  ? [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      },
    ]
  : undefined;

const body = {
  model: modelId,
  stream: true,
  stream_options: { include_usage: true },
  max_tokens: 256,
  messages: [
    { role: 'system', content: 'You are a sub-agent worker assisting the main coding agent.' },
    { role: 'user', content: 'Reply with exactly: hello. No tools needed, just reply.' },
  ],
  ...(tools ? { tools } : {}),
};

const t0 = Date.now();
const res = await fetch('http://127.0.0.1:1234/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
console.log(`HTTP ${res.status} after ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const reader = res.body!.getReader();
const dec = new TextDecoder();
let buf = '';
let firstChunkAt: number | null = null;
let chunks = 0;
let text = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
    chunks++;
    if (firstChunkAt === null)
      console.log(`first chunk at ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    firstChunkAt ??= Date.now();
    try {
      const j = JSON.parse(line.slice(5));
      const d = j.choices?.[0]?.delta;
      if (d?.content) text += d.content;
      if (d?.reasoning_content) text += '[R]';
    } catch {}
  }
}
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${chunks} chunks`);
console.log(`content: ${JSON.stringify(text.slice(0, 200))}`);
