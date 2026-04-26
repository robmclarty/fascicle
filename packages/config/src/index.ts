export { load_config, reset_config_for_tests } from './load.js';
export { CONFIG_SCHEMA, type Config } from './schema.js';

import { load_config } from './load.js';

export function get_node_env(): 'development' | 'test' | 'production' {
  return load_config().NODE_ENV;
}

export function get_anthropic_api_key(): string | undefined {
  return load_config().ANTHROPIC_API_KEY;
}

export function get_anthropic_base_url(): string | undefined {
  return load_config().ANTHROPIC_BASE_URL;
}

export function get_openai_api_key(): string | undefined {
  return load_config().OPENAI_API_KEY;
}

export function get_openai_base_url(): string | undefined {
  return load_config().OPENAI_BASE_URL;
}

export function get_openai_organization(): string | undefined {
  return load_config().OPENAI_ORGANIZATION;
}

export function get_google_api_key(): string | undefined {
  return load_config().GOOGLE_API_KEY;
}

export function get_google_base_url(): string | undefined {
  return load_config().GOOGLE_BASE_URL;
}

export function get_ollama_base_url(): string | undefined {
  return load_config().OLLAMA_BASE_URL;
}

export function get_lmstudio_base_url(): string | undefined {
  return load_config().LMSTUDIO_BASE_URL;
}

export function get_openrouter_api_key(): string | undefined {
  return load_config().OPENROUTER_API_KEY;
}

export function get_openrouter_base_url(): string | undefined {
  return load_config().OPENROUTER_BASE_URL;
}

export function get_openrouter_http_referer(): string | undefined {
  return load_config().OPENROUTER_HTTP_REFERER;
}

export function get_openrouter_x_title(): string | undefined {
  return load_config().OPENROUTER_X_TITLE;
}
