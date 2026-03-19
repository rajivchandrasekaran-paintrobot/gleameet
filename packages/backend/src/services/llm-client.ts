import OpenAI from 'openai';

const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
const LLM_API_KEY = process.env.LLM_API_KEY;

export const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';

export function buildLLMClient(): OpenAI {
  if (!LLM_API_KEY) {
    throw new Error('LLM_API_KEY environment variable is required');
  }
  return new OpenAI({
    apiKey: LLM_API_KEY,
    baseURL: LLM_BASE_URL,
  });
}
