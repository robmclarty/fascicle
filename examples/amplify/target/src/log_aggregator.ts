/**
 * Starter implementation: deliberately slow log aggregator.
 *
 * Reads a structured log file as a single string, scans it for ERROR-level
 * entries with `String.prototype.match` inside a per-service loop, and
 * returns a `{ service: count }` tally.
 *
 * Real-world headroom (the agent should be able to discover several of
 * these without breaking the regression suite):
 *
 * - The whole file is loaded into memory and scanned once per service.
 * - The regex is rebuilt on every call to `count_errors_for_service`.
 * - Each service gets its own full file scan; could be one pass.
 * - String concatenation via `match` allocates many substrings.
 *
 * The public surface is `aggregate(log_text, services)` returning a frozen
 * record. Tests pin this surface; mutations that change the surface die at
 * the gate stage.
 */

import { readFile } from 'node:fs/promises';

export type ServiceCounts = Readonly<Record<string, number>>;

const ESCAPE_REGEX_RE = /[.*+?^${}()|[\]\\]/g;

function escape_regex(s: string): string {
  return s.replace(ESCAPE_REGEX_RE, '\\$&');
}

function count_errors_for_service(log_text: string, service: string): number {
  const pattern = new RegExp(
    `\\bERROR\\b[^\\n]*\\bservice=${escape_regex(service)}(?=\\s|$)`,
    'gm',
  );
  const matches = log_text.match(pattern);
  return matches === null ? 0 : matches.length;
}

export function aggregate(
  log_text: string,
  services: ReadonlyArray<string>,
): ServiceCounts {
  const out: Record<string, number> = {};
  for (const s of services) {
    out[s] = count_errors_for_service(log_text, s);
  }
  return Object.freeze(out);
}

export async function aggregate_file(
  path: string,
  services: ReadonlyArray<string>,
): Promise<ServiceCounts> {
  const text = await readFile(path, 'utf8');
  return aggregate(text, services);
}
