/**
 * Bedrock ambient-credential-chain wire contract.
 *
 * `use_credential_chain` exists because omitting credentials does *not* reach
 * the AWS credential chain: @ai-sdk/amazon-bedrock resolves SigV4 keys with
 * `loadSetting({ environmentVariableName: 'AWS_ACCESS_KEY_ID' })`, which reads
 * the environment and nothing else. A shared-credentials profile is invisible
 * to it, so "omit the keys and let the chain resolve" silently produced an
 * unauthenticated client.
 *
 * The bug survived as long as it did because every test and every laptop had
 * `AWS_ACCESS_KEY_ID` exported, which masks the missing chain. So this suite
 * deletes those variables, points the SDK at a temp shared-credentials file,
 * and drives the real peer plus the real `fromNodeProviderChain()` over a
 * stubbed fetch. The assertion is the SigV4 `Authorization` header: it can only
 * carry the profile's access key if the chain actually read the file.
 *
 * The negative control matters as much as the positive one. Without the flag,
 * the same environment must fail to authenticate — that is what proves the
 * env-var path is genuinely absent and the passing case is not masked.
 *
 * No live network (C5): fetch is stubbed, and the profile credentials are
 * fabricated, so signing is exercised without an AWS account.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create_bedrock_adapter } from '../bedrock.js'
import { create_ai_sdk_turn } from '../ai_sdk/invoke.js'
import { create_chunk_dispatcher } from '../../streaming.js'
import type { Message, ProviderInit, TurnResult } from '../../types.js'

const MODEL_ID = 'us.anthropic.claude-sonnet-4-20250514-v1:0'
const REGION = 'us-east-1'

const MESSAGES: ReadonlyArray<Message> = [{ role: 'user', content: 'say hi' }]

// Fabricated, and shaped so a match in the signature cannot come from anywhere
// but the profile file written below.
const PROFILE_ACCESS_KEY = 'AKIAPROFILEONLYXXXXX'
const PROFILE_SECRET_KEY = 'profile-only-secret-key-never-in-env'
const PROFILE_SESSION_TOKEN = 'profile-only-session-token'

/**
 * Every AWS variable that could let credentials reach the SDK from somewhere
 * other than the profile file. All are deleted before each test so a developer
 * machine with real AWS exports cannot mask a broken chain.
 */
const AWS_ENV_KEYS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_ARN',
] as const

let temp_dir: string
let credentials_path: string

type CapturedRequest = {
  readonly url: string
  readonly headers: Record<string, string>
}

/** Minimal Converse response the SDK's response schema accepts. */
function converse_response(): Response {
  return new Response(
    JSON.stringify({
      output: { message: { role: 'assistant', content: [{ text: 'hello' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

/** Lower-case every header key so assertions do not depend on SDK casing. */
function normalize_headers(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (raw instanceof Headers) {
    raw.forEach((value, key) => {
      out[key.toLowerCase()] = value
    })
    return out
  }
  if (typeof raw === 'object' && raw !== null) {
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string') out[key.toLowerCase()] = value
    }
  }
  return out
}

/** Stub global fetch, capturing the signed headers of each outgoing request. */
function stub_capturing_fetch(): CapturedRequest[] {
  const captured: CapturedRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { headers?: unknown }) => {
      captured.push({ url: String(input), headers: normalize_headers(init?.headers) })
      return converse_response()
    }),
  )
  return captured
}

/** Drive one non-streamed bedrock turn through the real peer. */
async function run_turn(init: ProviderInit): Promise<TurnResult> {
  const adapter = create_bedrock_adapter(init)
  const turn = create_ai_sdk_turn({
    adapter,
    model_id: MODEL_ID,
    dispatcher: create_chunk_dispatcher(undefined),
    tools: [],
    schema: undefined,
    provider_options: undefined,
    temperature: undefined,
    max_tokens: undefined,
    top_p: undefined,
    telemetry: undefined,
  })
  return turn({
    step_index: 0,
    messages: MESSAGES,
    abort: new AbortController().signal,
    stream: false,
    on_first_chunk: () => {},
  })
}

/** Read the single captured request, failing the test if none landed. */
function single_request(captured: ReadonlyArray<CapturedRequest>): CapturedRequest {
  const request = captured[0]
  if (request === undefined || captured.length !== 1) {
    throw new Error(`expected exactly one captured request, got ${captured.length}`)
  }
  return request
}

beforeAll(() => {
  temp_dir = mkdtempSync(join(tmpdir(), 'fascicle-bedrock-chain-'))
  credentials_path = join(temp_dir, 'credentials')
  writeFileSync(
    credentials_path,
    [
      '[default]',
      `aws_access_key_id = ${PROFILE_ACCESS_KEY}`,
      `aws_secret_access_key = ${PROFILE_SECRET_KEY}`,
      `aws_session_token = ${PROFILE_SESSION_TOKEN}`,
      '',
    ].join('\n'),
  )
})

afterAll(() => {
  rmSync(temp_dir, { recursive: true, force: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('bedrock ambient credential chain wire contract', () => {
  /**
   * Put the process in the state the bug hid behind the absence of: no AWS
   * credentials in the environment at all, one shared-credentials profile on
   * disk, and no route to instance metadata.
   */
  function isolate_env_to_profile_only(): void {
    for (const key of AWS_ENV_KEYS) vi.stubEnv(key, undefined)
    vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', credentials_path)
    // Point the config file at a path that does not exist so a real ~/.aws/config
    // cannot contribute a profile.
    vi.stubEnv('AWS_CONFIG_FILE', join(temp_dir, 'absent-config'))
    vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true')
  }

  it('signs with credentials the chain read from ~/.aws/credentials, with AWS_ACCESS_KEY_ID absent', async () => {
    isolate_env_to_profile_only()
    const captured = stub_capturing_fetch()

    await run_turn({ region: REGION, use_credential_chain: true })

    const request = single_request(captured)
    expect(request.url).toContain('/converse')
    const authorization = request.headers['authorization'] ?? ''
    // The credential scope names the access key the signature was derived from.
    // Only the profile file could have supplied it.
    expect(authorization).toContain('AWS4-HMAC-SHA256')
    expect(authorization).toContain(`Credential=${PROFILE_ACCESS_KEY}/`)
    expect(authorization).toContain(`/${REGION}/bedrock/aws4_request`)
    // The profile's session token rides along, proving the whole credential
    // record was threaded rather than just the key pair.
    expect(request.headers['x-amz-security-token']).toBe(PROFILE_SESSION_TOKEN)
  })

  it('fails to authenticate in the same environment without the flag', async () => {
    isolate_env_to_profile_only()
    const captured = stub_capturing_fetch()

    // This is the negative control: it pins that the environment really is
    // stripped, so the test above cannot pass on ambient env vars. Before
    // use_credential_chain existed, this was the only available behavior and it
    // was documented as "the ambient AWS credential chain".
    await expect(run_turn({ region: REGION })).rejects.toThrow(/AWS_ACCESS_KEY_ID|accessKeyId/)
    expect(captured).toHaveLength(0)
  })

  it('signs with explicit keys rather than the profile when both are supplied', async () => {
    isolate_env_to_profile_only()
    const captured = stub_capturing_fetch()

    await run_turn({
      region: REGION,
      use_credential_chain: true,
      access_key_id: 'AKIAEXPLICITXXXXXXXX',
      secret_access_key: 'explicit-secret',
    })

    const request = single_request(captured)
    expect(request.headers['authorization']).toContain('Credential=AKIAEXPLICITXXXXXXXX/')
    expect(request.headers['authorization']).not.toContain(PROFILE_ACCESS_KEY)
  })

  it('uses a caller-supplied credential_provider ahead of the chain', async () => {
    isolate_env_to_profile_only()
    const captured = stub_capturing_fetch()

    await run_turn({
      region: REGION,
      credential_provider: () =>
        Promise.resolve({
          accessKeyId: 'AKIAASSUMEDROLEXXXXX',
          secretAccessKey: 'assumed-secret',
          sessionToken: 'assumed-session',
        }),
    })

    const request = single_request(captured)
    expect(request.headers['authorization']).toContain('Credential=AKIAASSUMEDROLEXXXXX/')
    expect(request.headers['x-amz-security-token']).toBe('assumed-session')
  })

  it('keeps the bearer-token path free of SigV4 signing and of the credential-providers peer', async () => {
    isolate_env_to_profile_only()
    const captured = stub_capturing_fetch()

    await run_turn({ region: REGION, api_key: 'test-bearer-token', use_credential_chain: true })

    const request = single_request(captured)
    expect(request.headers['authorization']).toBe('Bearer test-bearer-token')
    expect(request.headers['x-amz-security-token']).toBeUndefined()
  })
})
