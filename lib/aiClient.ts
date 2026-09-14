import OpenAI from 'openai';

let client: OpenAI | null = null;
let lastKey = '';

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
  if (!key || key === 'dummy-key' || key === 'your_deepseek_api_key_here') return null;
  if (!client || lastKey !== key) {
    lastKey = key;
    client = new OpenAI({
      baseURL: 'https://api.deepseek.com',
      apiKey: key,
    });
  }
  return client;
}

export function requireDeepseekClient() {
  const next = getDeepseekClient();
  if (!next) {
    throw new Error('OSe AI is not configured. Add an API key in Super Admin → Global Settings.');
  }
  return next;
}

export function resetDeepseekClient() {
  client = null;
  lastKey = '';
}
