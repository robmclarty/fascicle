import { CONFIG_SCHEMA, type Config } from './schema.js'

const ENV_FILES_ORDER: ReadonlyArray<(node_env: string) => string> = [
  () => '.env',
  (node_env) => `.env.${node_env}`,
  () => '.env.local',
  (node_env) => `.env.${node_env}.local`,
]

function try_load_env_file(path: string): void {
  try {
    process.loadEnvFile(path)
  } catch (err: unknown) {
    if (err !== null && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return
    }
    throw err
  }
}

let cached: Config | undefined

export function load_config(): Config {
  if (cached !== undefined) return cached

  const node_env = process.env['NODE_ENV'] ?? 'development'
  for (const resolve of ENV_FILES_ORDER) {
    try_load_env_file(resolve(node_env))
  }

  const parsed = CONFIG_SCHEMA.safeParse(process.env)
  if (!parsed.success) {
    const formatted = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(`@repo/config: invalid environment:\n${formatted}`)
  }

  cached = Object.freeze(parsed.data)
  return cached
}

export function reset_config_for_tests(): void {
  cached = undefined
}
