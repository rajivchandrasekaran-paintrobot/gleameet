import OpenAI from 'openai';

const LLM_BASE_URL = process.env.LLM_BASE_URL || 'http://localhost:11434/v1';
const LLM_API_KEY = process.env.LLM_API_KEY || 'ollama';

export const LLM_MODEL = process.env.LLM_MODEL || 'llama3.2';

export function buildLLMClient(): OpenAI {
  return new OpenAI({
    apiKey: LLM_API_KEY,
    baseURL: LLM_BASE_URL,
  });
}
