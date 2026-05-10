// server.js - OpenAI to NVIDIA NIM API Proxy (Optimized for Janitor AI)
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// NVIDIA NIM API configuration
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// 🔥 REASONING DISPLAY TOGGLE - Shows/hides reasoning in output
const SHOW_REASONING = process.env.SHOW_REASONING === 'true' || false;

// 🔥 THINKING MODE TOGGLE - Enables thinking for specific models that support it
const ENABLE_THINKING_MODE = process.env.ENABLE_THINKING_MODE === 'true' || false;

// Request timeout in ms (30 seconds)
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || '30000', 10);

// 🎯 VERIFIED MODEL MAPPING FOR JANITOR AI
// Only real, confirmed models available on NVIDIA NIM (as of early 2025)
const MODEL_MAPPING = {
  // Premium / High-quality
  'gpt-4':              'deepseek-ai/deepseek-r1',               // 671B reasoning model
  'gpt-4-turbo':        'deepseek-ai/deepseek-r1-0528',          // Updated DeepSeek R1
  'gpt-4o':             'deepseek-ai/deepseek-v3-0324',          // DeepSeek V3 (non-reasoning)
  'claude-opus':        'nvidia/llama-3.1-nemotron-ultra-253b-v1', // 253B, highest accuracy
  'claude-sonnet':      'nvidia/llama-3.3-nemotron-super-49b-v1', // 49B, great balance

  // Fast & Efficient
  'gpt-3.5-turbo':      'nvidia/llama-3.1-nemotron-nano-8b-v1',  // 8B, fast
  'gpt-3.5-turbo-16k':  'meta/llama-3.3-70b-instruct',           // 70B, large context
  'claude-haiku':       'meta/llama-3.1-8b-instruct',            // Lightweight & quick

  // Specialized
  'gemini-pro':         'qwen/qwen2.5-72b-instruct',             // Qwen 72B
  'gemini-pro-vision':  'microsoft/phi-3-vision-128k-instruct',  // Vision-capable

  // Direct access aliases
  'gpt-4-reasoning':    'deepseek-ai/deepseek-r1',               // Explicit reasoning
  'deepseek':           'deepseek-ai/deepseek-v3-0324',          // DeepSeek V3

  // Meta Llama fallbacks
  'llama-70b':          'meta/llama-3.1-70b-instruct',
  'llama-405b':         'meta/llama-3.1-405b-instruct',
  'llama-8b':           'meta/llama-3.1-8b-instruct',
};

// 🛡️ ROLEPLAY GUARD - Injected into every request to prevent the model from speaking as the user
const RP_GUARD_INSTRUCTION = `You are ONLY the character described in the system prompt or conversation. Follow these rules strictly:
- You ONLY speak, act, and think as the character. You do NEVER write or generate any dialogue, actions, or thoughts for the user or any other character that the user is playing.
- Do NOT use labels like "User:", "Human:", "You:" or any prefix to simulate the user's side of the conversation.
- Do NOT continue the conversation by inventing what the user says or does next.
- Stop your response immediately after your character's turn ends.
- If you feel the scene needs a reaction from the user, end your response and wait.`;

// 🛡️ ROLEPLAY GUARD - Strips any text where the model broke character and started writing as the user
function stripUserBreakout(text) {
  const lines = text.split('\n');
  const cleaned = [];
  let dropping = false;

  // Patterns that signal the model started writing the user's side
  const userLabels = [
    /^(User|Human|You|Me|Player)\s*[:：]/i,
    /^---+\s*$/,
    /^\*{0,3}\s*(User|Human|You|Me|Player)\s*\*{0,3}\s*[:：]/i,
  ];

  for (const line of lines) {
    const trimmed = line.trim();

    // Hit a user-label line → start dropping everything after it
    if (userLabels.some(pattern => pattern.test(trimmed))) {
      dropping = true;
      continue;
    }

    if (dropping) {
      if (trimmed === '') continue;           // Skip blank lines while dropping
      if (trimmed.startsWith('*')) {         // Asterisk = character action resumes
        dropping = false;
        cleaned.push(line);
      }
      continue;                              // Still dropping invented user dialogue
    }

    cleaned.push(line);
  }

  // Final safety net: cut off at the last user label that slipped through
  const result = cleaned.join('\n');
  const lastUserLabel = result.search(/\n(?:User|Human|You|Me|Player)\s*[:：]/i);
  if (lastUserLabel !== -1) {
    return result.substring(0, lastUserLabel).trimEnd();
  }

  return result.trimEnd();
}

// 🎨 THINKING-CAPABLE MODELS (verified models that support reasoning/thinking)
const THINKING_MODELS = new Set([
  'deepseek-ai/deepseek-r1',
  'deepseek-ai/deepseek-r1-0528',
  'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'nvidia/llama-3.3-nemotron-super-49b-v1',
  'nvidia/llama-3.1-nemotron-nano-8b-v1',
]);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OpenAI to NVIDIA NIM Proxy (Janitor AI Optimized)',
    reasoning_display: SHOW_REASONING,
    thinking_mode: ENABLE_THINKING_MODE,
    nim_api_configured: !!NIM_API_KEY,
    available_models: Object.keys(MODEL_MAPPING).length,
    optimized_for: 'Janitor AI',
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'OpenAI to NVIDIA NIM Proxy',
    version: '2.1',
    optimized_for: 'Janitor AI',
    status: 'running',
    endpoints: {
      health: '/health',
      models: '/v1/models',
      chat: '/v1/chat/completions',
    },
    featured_models: {
      best_quality:  'gpt-4 → deepseek-r1 (671B reasoning)',
      balanced:      'claude-sonnet → llama-3.3-nemotron-super (49B)',
      fastest:       'gpt-3.5-turbo → llama-3.1-nemotron-nano (8B)',
    },
  });
});

// List models endpoint (OpenAI compatible)
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'nvidia-nim-proxy',
    nim_model: MODEL_MAPPING[model],
    supports_thinking: THINKING_MODELS.has(MODEL_MAPPING[model]),
  }));

  res.json({ object: 'list', data: models });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve the NIM model name for a given OpenAI-style model id.
 * Falls back through a pattern-matching chain; never makes a live probe
 * (the probe used a shadowed `res` variable and added unnecessary latency).
 */
function resolveNimModel(requestedModel) {
  // Exact match in our map
  if (MODEL_MAPPING[requestedModel]) return MODEL_MAPPING[requestedModel];

  // If the caller already sent a NIM-style model id, pass it through
  if (requestedModel.includes('/')) return requestedModel;

  // Pattern-based fallback
  const lower = requestedModel.toLowerCase();
  if (lower.includes('gpt-4') || lower.includes('opus'))          return 'deepseek-ai/deepseek-r1';
  if (lower.includes('deepseek'))                                  return 'deepseek-ai/deepseek-v3-0324';
  if (lower.includes('claude-sonnet') || lower.includes('70b'))   return 'nvidia/llama-3.3-nemotron-super-49b-v1';
  if (lower.includes('3.5') || lower.includes('haiku') || lower.includes('fast')) return 'nvidia/llama-3.1-nemotron-nano-8b-v1';
  if (lower.includes('gemini') || lower.includes('qwen'))         return 'qwen/qwen2.5-72b-instruct';

  // Safe default
  return 'nvidia/llama-3.3-nemotron-super-49b-v1';
}

/**
 * Inject the RP guard into the messages array (mutates a shallow copy).
 */
function injectRpGuard(messages) {
  const copy = messages.map(m => ({ ...m }));
  const sysIdx = copy.findIndex(m => m.role === 'system');
  if (sysIdx !== -1) {
    copy[sysIdx] = {
      ...copy[sysIdx],
      content: copy[sysIdx].content + '\n\n' + RP_GUARD_INSTRUCTION,
    };
  } else {
    copy.unshift({ role: 'system', content: RP_GUARD_INSTRUCTION });
  }
  return copy;
}

// ─── Chat Completions ────────────────────────────────────────────────────────

app.post('/v1/chat/completions', async (req, res) => {
  try {
    if (!NIM_API_KEY) {
      return res.status(500).json({
        error: {
          message: 'NIM_API_KEY not configured. Please add your NVIDIA API key in environment variables.',
          type: 'configuration_error',
          code: 500,
        },
      });
    }

    const { model, messages, temperature, max_tokens, stream } = req.body;

    const nimModel  = resolveNimModel(model);
    const patchedMessages = injectRpGuard(messages);

    // Build the NIM request body
    const nimRequest = {
      model:       nimModel,
      messages:    patchedMessages,
      temperature: temperature ?? 0.7,
      max_tokens:  max_tokens  ?? 4096,
      stream:      stream      ?? false,
    };

    // Add thinking mode if enabled and the model supports it
    if (ENABLE_THINKING_MODE && THINKING_MODELS.has(nimModel)) {
      if (nimModel.includes('deepseek')) {
        // DeepSeek: pass thinking flag in the request body directly
        nimRequest.thinking = true;
      } else if (nimModel.includes('nemotron')) {
        // Nemotron: prepend a system instruction (only if no system msg yet)
        if (nimRequest.messages[0]?.role !== 'system') {
          nimRequest.messages.unshift({ role: 'system', content: 'detailed thinking on' });
        }
      }
    }

    // ── Streaming response ───────────────────────────────────────────────────
    if (stream) {
      const nimResponse = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
        headers: {
          Authorization: `Bearer ${NIM_API_KEY}`,
          'Content-Type': 'application/json',
        },
        responseType: 'stream',
        timeout: REQUEST_TIMEOUT,
      });

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let buffer = '';
      let reasoningOpen = false;

      // Accumulator for the user-breakout filter with a lookahead window
      let contentAccumulator = '';
      let flushedUpTo = 0;
      const LOOKAHEAD = 200;

      // Flush a text fragment as a streaming delta chunk
      function sendDelta(data, text) {
        const outData = {
          ...data,
          choices: [{
            ...data.choices[0],
            delta: { ...data.choices[0].delta, content: text },
          }],
        };
        delete outData.choices[0].delta.reasoning_content;
        res.write(`data: ${JSON.stringify(outData)}\n\n`);
      }

      // Flush whatever remains in the accumulator that hasn't been sent yet
      function flushRemaining(data) {
        if (contentAccumulator.length <= flushedUpTo) return;
        const filtered = stripUserBreakout(contentAccumulator);
        const remaining = filtered.substring(flushedUpTo);
        if (remaining.length > 0) sendDelta(data, remaining);
      }

      nimResponse.data.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;

          if (line.includes('[DONE]')) {
            // We need a placeholder data object for flushRemaining;
            // build a minimal one if we have leftover content.
            // The actual [DONE] is sent after.
            res.write('data: [DONE]\n\n');
            continue;
          }

          let data;
          try {
            data = JSON.parse(line.slice(6));
          } catch {
            res.write(line + '\n');
            continue;
          }

          if (!data.choices?.[0]?.delta) {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
            continue;
          }

          const reasoning = data.choices[0].delta.reasoning_content ?? '';
          const content   = data.choices[0].delta.content          ?? '';

          // Build the text this chunk will contribute
          let chunkText = '';

          if (SHOW_REASONING) {
            if (reasoning && !reasoningOpen) {
              chunkText = '<think>\n' + reasoning;
              reasoningOpen = true;
            } else if (reasoning) {
              chunkText = reasoning;
            }

            if (content && reasoningOpen) {
              chunkText += '\n</think>\n\n' + content;
              reasoningOpen = false;
            } else if (content) {
              chunkText += content;
            }
          } else {
            // Suppress reasoning; only forward regular content
            chunkText = content;
          }

          if (!chunkText) continue; // Nothing to forward for this chunk

          // Run through the user-breakout filter with a lookahead window
          contentAccumulator += chunkText;
          const filtered = stripUserBreakout(contentAccumulator);
          const safeEnd  = Math.max(flushedUpTo, filtered.length - LOOKAHEAD);

          if (safeEnd > flushedUpTo) {
            const toSend = filtered.substring(flushedUpTo, safeEnd);
            flushedUpTo = safeEnd;
            sendDelta(data, toSend);
          }
          // If not enough has accumulated yet, hold back and wait for more chunks
        }
      });

      nimResponse.data.on('end', () => {
        // Flush the lookahead window now that the stream is complete
        if (contentAccumulator.length > flushedUpTo) {
          const filtered   = stripUserBreakout(contentAccumulator);
          const remaining  = filtered.substring(flushedUpTo);
          if (remaining.length > 0) {
            // We need a valid SSE frame; build a minimal one
            const finalFrame = {
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: nimModel,
              choices: [{ index: 0, delta: { content: remaining }, finish_reason: null }],
            };
            res.write(`data: ${JSON.stringify(finalFrame)}\n\n`);
          }
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });

      nimResponse.data.on('error', err => {
        console.error('Stream error:', err.message);
        res.end();
      });

    // ── Non-streaming response ───────────────────────────────────────────────
    } else {
      const nimResponse = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
        headers: {
          Authorization: `Bearer ${NIM_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: REQUEST_TIMEOUT,
      });

      const openaiResponse = {
        id:      `chatcmpl-${Date.now()}`,
        object:  'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model:   model,
        choices: nimResponse.data.choices.map(choice => {
          let fullContent = choice.message?.content ?? '';

          // Strip model-playing-user breakouts
          fullContent = stripUserBreakout(fullContent);

          // Optionally prepend reasoning
          if (SHOW_REASONING && choice.message?.reasoning_content) {
            fullContent = '<think>\n' + choice.message.reasoning_content + '\n</think>\n\n' + fullContent;
          }

          return {
            index:         choice.index,
            message:       { role: choice.message.role, content: fullContent },
            finish_reason: choice.finish_reason,
          };
        }),
        usage: nimResponse.data.usage ?? {
          prompt_tokens:     0,
          completion_tokens: 0,
          total_tokens:      0,
        },
      };

      res.json(openaiResponse);
    }

  } catch (error) {
    console.error('Proxy error:', error.message);

    let errorMessage = error.message || 'Internal server error';
    let statusCode   = error.response?.status || 500;

    if (statusCode === 401) {
      errorMessage = 'Invalid NVIDIA API key. Please check your NIM_API_KEY in environment variables.';
    } else if (statusCode === 429) {
      errorMessage = 'Rate limit exceeded. Please try again in a moment.';
    } else if (error.code === 'ECONNABORTED') {
      errorMessage = 'Request timed out. The upstream NIM API did not respond in time.';
      statusCode   = 504;
    } else if (error.response?.data?.detail) {
      errorMessage = error.response.data.detail;
    }

    res.status(statusCode).json({
      error: {
        message: errorMessage,
        type:    'invalid_request_error',
        code:    statusCode,
      },
    });
  }
});

// Catch-all for unsupported endpoints
app.all('*', (req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found. Available: /health, /v1/models, /v1/chat/completions`,
      type: 'invalid_request_error',
      code: 404,
    },
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('═══════════════════════════════════════════════════════');
  console.log('🚀 OpenAI → NVIDIA NIM Proxy (Janitor AI Optimized)');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`📡 Server running on port ${PORT}`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
  console.log(`📋 Models list:  http://localhost:${PORT}/v1/models`);
  console.log('');
  console.log('⚙️  Configuration:');
  console.log(`   • Reasoning display : ${SHOW_REASONING       ? '✅ ENABLED' : '❌ DISABLED'}`);
  console.log(`   • Thinking mode     : ${ENABLE_THINKING_MODE ? '✅ ENABLED' : '❌ DISABLED'}`);
  console.log(`   • API key           : ${NIM_API_KEY          ? '✅ Configured' : '❌ Missing'}`);
  console.log(`   • Request timeout   : ${REQUEST_TIMEOUT}ms`);
  console.log('');
  console.log('🎯 Featured Models:');
  console.log('   • Best Quality : gpt-4       → DeepSeek R1 (671B)');
  console.log('   • Balanced     : claude-sonnet → Llama Nemotron Super (49B)');
  console.log('   • Fastest      : gpt-3.5-turbo → Llama Nemotron Nano (8B)');
  console.log('═══════════════════════════════════════════════════════');
});nsole.log('═══════════════════════════════════════════════════════');
});
