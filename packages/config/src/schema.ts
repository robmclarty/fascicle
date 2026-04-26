import { z } from 'zod';

const optional_string = z
  .string()
  .trim()
  .min(1)
  .optional();

export const CONFIG_SCHEMA = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  ANTHROPIC_API_KEY: optional_string,
  ANTHROPIC_BASE_URL: optional_string,

  OPENAI_API_KEY: optional_string,
  OPENAI_BASE_URL: optional_string,
  OPENAI_ORGANIZATION: optional_string,

  GOOGLE_API_KEY: optional_string,
  GOOGLE_BASE_URL: optional_string,

  OLLAMA_BASE_URL: optional_string,
  LMSTUDIO_BASE_URL: optional_string,

  OPENROUTER_API_KEY: optional_string,
  OPENROUTER_BASE_URL: optional_string,
  OPENROUTER_HTTP_REFERER: optional_string,
  OPENROUTER_X_TITLE: optional_string,
});

export type Config = z.infer<typeof CONFIG_SCHEMA>;
