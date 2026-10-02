import OpenAI from 'openai';

interface AiProviderConfig {
  name: string;
  client: OpenAI;
  model: string;
}

let deepseekClient: OpenAI | null = null;
let lastDeepseekKey = '';

let groqClient: OpenAI | null = null;
let lastGroqKey = '';

let openaiClient: OpenAI | null = null;
let lastOpenaiKey = '';

export function getAiModel() {
  return process.env.OSE_MODEL || 'deepseek-chat';
}

export function getAiTemperature() {
  const parsed = Number(process.env.OSE_TEMPERATURE || '0.7');
  return Number.isFinite(parsed) ? parsed : 0.7;
}

export function getDeepseekClient(): OpenAI | null {
  if (process.env.OSE_ENABLED === 'false') return null;
  const key = process.env.DEEPSEEK_API_KEY || '';
  if (!key || key === 'dummy-key' || key === 'your_deepseek_api_key_here') {
    // If DeepSeek key is missing, check if GROQ or OPENAI can act as the fallback client
    return getGroqClient() || getOpenAiClient();
  }

  // If the key is actually a Groq key (starts with gsk_)
  if (key.startsWith('gsk_')) {
    return getGroqClient(key);
  }

  // If the key is an OpenAI key (starts with sk-proj-)
  if (key.startsWith('sk-proj-')) {
    return getOpenAiClient(key);
  }

  if (!deepseekClient || lastDeepseekKey !== key) {
    lastDeepseekKey = key;
    deepseekClient = new OpenAI({
      baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      apiKey: key,
    });
  }
  return deepseekClient;
}

export function getGroqClient(explicitKey?: string): OpenAI | null {
  const key = explicitKey || process.env.GROQ_API_KEY || '';
  if (!key || key === 'dummy-key') return null;
  if (!groqClient || lastGroqKey !== key) {
    lastGroqKey = key;
    groqClient = new OpenAI({
      baseURL: 'https://api.groq.com/openai/v1',
      apiKey: key,
    });
  }
  return groqClient;
}

export function getOpenAiClient(explicitKey?: string): OpenAI | null {
  const key = explicitKey || process.env.OPENAI_API_KEY || '';
  if (!key || key === 'dummy-key') return null;
  if (!openaiClient || lastOpenaiKey !== key) {
    lastOpenaiKey = key;
    openaiClient = new OpenAI({
      baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      apiKey: key,
    });
  }
  return openaiClient;
}

export function requireDeepseekClient() {
  const next = getDeepseekClient() || getGroqClient() || getOpenAiClient();
  if (!next) {
    throw new Error('AI service is not configured. Add an API key in Super Admin → Global Settings or backend .env.');
  }
  return next;
}

export function resetDeepseekClient() {
  deepseekClient = null;
  lastDeepseekKey = '';
  groqClient = null;
  lastGroqKey = '';
  openaiClient = null;
  lastOpenaiKey = '';
}

export interface AiChatParams {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  responseFormatJson?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface AiChatResult {
  content: string;
  provider: string;
  model: string;
}

/**
 * Executes chat completion across available providers with automatic fallback.
 * Tries DeepSeek first; if 402 Insufficient Balance, timeout, or rate-limited, cascades to Groq / OpenAI.
 */
export async function executeAiChatCompletion(params: AiChatParams): Promise<AiChatResult> {
  const providers: AiProviderConfig[] = [];

  // Provider 1: DeepSeek (if key configured and not a gsk_ key)
  const dsKey = process.env.DEEPSEEK_API_KEY || '';
  if (process.env.OSE_ENABLED !== 'false' && dsKey && !dsKey.startsWith('gsk_') && !dsKey.startsWith('sk-proj-') && dsKey !== 'dummy-key') {
    const client = new OpenAI({
      baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      apiKey: dsKey,
      timeout: 25000,
    });
    providers.push({
      name: 'DeepSeek',
      client,
      model: process.env.OSE_MODEL || 'deepseek-chat',
    });
  }

  // Provider 2: Groq (high-speed fallback or primary if GROQ_API_KEY is present)
  const groqKey = process.env.GROQ_API_KEY || (dsKey.startsWith('gsk_') ? dsKey : '');
  if (groqKey) {
    const client = new OpenAI({
      baseURL: 'https://api.groq.com/openai/v1',
      apiKey: groqKey,
      timeout: 25000,
    });
    providers.push({
      name: 'Groq',
      client,
      model: process.env.GROQ_MODEL || 'qwen/qwen3.8-27b',
    });
  }

  // Provider 3: OpenAI (if OPENAI_API_KEY is present)
  const openAiKey = process.env.OPENAI_API_KEY || (dsKey.startsWith('sk-proj-') ? dsKey : '');
  if (openAiKey) {
    const client = new OpenAI({
      baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      apiKey: openAiKey,
      timeout: 25000,
    });
    providers.push({
      name: 'OpenAI',
      client,
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    });
  }

  if (providers.length === 0) {
    throw new Error('No AI provider configured. Set DEEPSEEK_API_KEY, GROQ_API_KEY, or OPENAI_API_KEY.');
  }

  let lastError: any = null;

  for (const provider of providers) {
    try {
      const response = await provider.client.chat.completions.create({
        model: provider.model,
        temperature: params.temperature ?? getAiTemperature(),
        response_format: params.responseFormatJson ? { type: 'json_object' } : undefined,
        messages: params.messages as any,
        max_tokens: params.maxTokens,
      });

      const content = response.choices?.[0]?.message?.content || '';
      if (content) {
        return {
          content,
          provider: provider.name,
          model: provider.model,
        };
      }
    } catch (err: any) {
      lastError = err;
      const status = err?.status || err?.response?.status;
      const errMsg = err?.message || String(err);
      console.warn(`[AI Orchestrator] Provider ${provider.name} failed (${status || 'error'}): ${errMsg}. Trying fallback if available.`);
    }
  }

  throw lastError || new Error('All AI providers failed to return a response.');
}
