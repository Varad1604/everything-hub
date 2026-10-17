// OpenAI-compatible AI endpoints on Cloudflare Workers AI (binding AI).
import { json } from './runtime.js';

export const CHAT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const FALLBACK_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
export const VISION_MODEL = '@cf/llava-hf/llava-1.5-7b-hf';
export const IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';
export const STT_MODEL = '@cf/openai/whisper';
export const TTS_MODEL = '@cf/myshell-ai/melotts';

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p === 'string' ? p : p && p.type === 'text' ? p.text : '')).join('\n') : c == null ? '' : String(c));
function imagesOf(messages) {
  const out = [];
  for (const m of messages || []) if (Array.isArray(m.content)) for (const p of m.content) if (p && p.type === 'image_url' && p.image_url) out.push(p.image_url.url || p.image_url);
  return out;
}
async function imageBytes(u) {
  if (/^data:/.test(u)) { const b = atob(u.split(',')[1] || ''); const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }
  const r = await fetch(u, { signal: AbortSignal.timeout(15000) }); return new Uint8Array(await r.arrayBuffer());
}
function cleanMessages(messages) {
  return (messages || []).map((m) => {
    const role = ['system', 'user', 'assistant', 'tool'].includes(m.role) ? m.role : 'user';
    const o = { role, content: textOf(m.content) };
    if (m.tool_call_id) o.tool_call_id = m.tool_call_id;
    if (m.tool_calls) o.tool_calls = m.tool_calls;
    return o;
  });
}
function pickModel(requested) { return typeof requested === 'string' && /^@cf\//.test(requested) ? requested : CHAT_MODEL; }

async function runChat(env, body) {
  const model = pickModel(body.model);
  const input = { messages: cleanMessages(body.messages), max_tokens: Math.min(Number(body.max_tokens) || 2048, 4096) };
  if (body.temperature != null) input.temperature = Number(body.temperature);
  if (body.tools && body.tools.length) input.tools = body.tools.map((t) => (t.type === 'function' && t.function ? t.function : t));
  if (body.response_format && body.response_format.type === 'json_schema') input.response_format = { type: 'json_schema', json_schema: body.response_format.json_schema && body.response_format.json_schema.schema || body.response_format.json_schema };
  if (body.stream) input.stream = true;
  try { return { model, out: await env.AI.run(model, input) }; }
  catch (e) {
    if (model === FALLBACK_MODEL) throw e;
    delete input.response_format;
    return { model: FALLBACK_MODEL, out: await env.AI.run(FALLBACK_MODEL, input) };
  }
}

export async function aiChatCompletions(env, body) {
  const id = 'chatcmpl-' + crypto.randomUUID().slice(0, 12), created = Math.floor(Date.now() / 1000);
  const imgs = imagesOf(body.messages);
  if (imgs.length) {
    try {
      const last = [...(body.messages || [])].reverse().find((m) => m.role === 'user');
      const r = await env.AI.run(VISION_MODEL, { image: [...(await imageBytes(imgs[0]))], prompt: textOf(last && last.content) || 'Describe this image.', max_tokens: 1024 });
      const content = (r && (r.description || r.response)) || '';
      if (body.stream) return sse([{ id, object: 'chat.completion.chunk', created, model: VISION_MODEL, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: 'stop' }] }]);
      return json({ id, object: 'chat.completion', created, model: VISION_MODEL, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
    } catch (e) { /* fall through to text-only */ }
  }
  let res;
  try { res = await runChat(env, body); }
  catch (e) { return json({ error: { message: 'The AI service is busy or over its daily free quota. Try again later. (' + String(e.message || e).slice(0, 160) + ')' } }, 503); }
  const { model, out } = res;
  if (body.stream && out instanceof ReadableStream) {
    const enc = new TextEncoder(), dec = new TextDecoder();
    let buf = '', first = true;
    const ts = new TransformStream({
      transform(chunk, c) {
        buf += dec.decode(chunk, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          const t = line.trim(); if (!t.startsWith('data:')) continue;
          const d = t.slice(5).trim(); if (d === '[DONE]') continue;
          let j; try { j = JSON.parse(d); } catch { continue; }
          const delta = {}; if (first) { delta.role = 'assistant'; first = false; }
          if (j.response) delta.content = j.response;
          if (j.tool_calls) delta.tool_calls = j.tool_calls.map((tc, i) => ({ index: i, id: 'call_' + i, type: 'function', function: { name: tc.name, arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}) } }));
          const o = { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: null }] };
          if (j.usage) o.usage = j.usage;
          c.enqueue(enc.encode('data: ' + JSON.stringify(o) + '\n\n'));
        }
      },
      flush(c) {
        c.enqueue(enc.encode('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n'));
        c.enqueue(enc.encode('data: [DONE]\n\n'));
      },
    });
    return new Response(out.pipeThrough(ts), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
  }
  const message = { role: 'assistant', content: typeof out.response === 'string' ? out.response : out.response != null ? JSON.stringify(out.response) : '' };
  if (out.tool_calls && out.tool_calls.length) {
    message.tool_calls = out.tool_calls.map((tc, i) => ({ id: 'call_' + crypto.randomUUID().slice(0, 8), type: 'function', function: { name: tc.name, arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}) } }));
  }
  const reply = { id, object: 'chat.completion', created, model, choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: out.usage };
  if (body.stream) return sse([{ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: message, finish_reason: reply.choices[0].finish_reason }] }]);
  return json(reply);
}
function sse(chunks) {
  const s = chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n';
  return new Response(s, { headers: { 'content-type': 'text/event-stream' } });
}

export async function aiImages(env, body) {
  try {
    const r = await env.AI.run(IMAGE_MODEL, { prompt: String(body.prompt || '').slice(0, 2000), steps: 4 });
    return json({ created: Math.floor(Date.now() / 1000), data: [{ b64_json: r.image }] });
  } catch (e) { return json({ error: { message: 'Image generation is unavailable right now.' } }, 503); }
}

export async function aiTranscribe(env, form) {
  const f = form.get('file');
  if (!f || typeof f.arrayBuffer !== 'function') return json({ error: { message: 'Attach an audio file as "file".' } }, 400);
  if (f.size > 25 * 1024 * 1024) return json({ error: { message: 'Audio is too long.' } }, 413);
  try {
    const r = await env.AI.run(STT_MODEL, { audio: [...new Uint8Array(await f.arrayBuffer())] });
    return json({ text: r.text || '' });
  } catch (e) { return json({ error: { message: 'Transcription is unavailable right now.' } }, 503); }
}

export async function aiSpeech(env, body) {
  try {
    const r = await env.AI.run(TTS_MODEL, { prompt: String(body.input || '').slice(0, 3000), lang: 'en' });
    const b = atob(r.audio || ''); const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
    return new Response(a, { headers: { 'content-type': 'audio/mpeg' } });
  } catch (e) { return json({ error: { message: 'Speech is unavailable right now.' } }, 503); }
}

// ehub.ai.chat() for team-server scripts: (prompt | messages, [opts]) -> { message, toString() }
export async function aiChatSimple(env, prompt, ...rest) {
  if (!env.AI) throw new Error('AI is not enabled on this server.');
  const opts = rest.find((x) => x && typeof x === 'object' && !Array.isArray(x)) || {};
  const messages = Array.isArray(prompt) ? prompt.map((m) => (typeof m === 'string' ? { role: 'user', content: m } : m)) : [{ role: 'user', content: String(prompt) }];
  const { model, out } = await runChat(env, { messages, max_tokens: opts.max_tokens, temperature: opts.temperature, tools: opts.tools });
  const content = typeof out.response === 'string' ? out.response : JSON.stringify(out.response || '');
  const res = { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop', model };
  res.toString = () => content; res.valueOf = res.toString;
  return res;
}
