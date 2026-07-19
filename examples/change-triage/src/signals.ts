/**
 * Deterministic risk detectors. They run over every parsed file before the
 * model sees anything, cost zero tokens, and cannot hallucinate. The model is
 * asked to corroborate and extend these signals, never to contradict them;
 * floor.ts turns the hard ones into a score the model cannot undercut.
 */

import type { DiffFile, Signal } from './types.js'

const MIGRATION_PATH = /(^|\/)migrations?\/|\.sql$/i
const DEPENDENCY_PATH =
  /(^|\/)(package\.json|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|requirements\.txt|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?)$/
const INFRA_PATH = /(^|\/)(\.github\/workflows\/|Dockerfile|docker-compose|terraform\/|k8s\/|helm\/|deploy)/i
const TEST_PATH = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.\w+$/i
const CODE_PATH = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|sql)$/i

// Stems, not whole words: auth logic hides in identifiers like has_permission
// or verifyToken where `\b` would miss the interior match.
const AUTH_LINE = /authoriz|authentic|permission|session|token|\brole\b|\bacl\b|tenant/i
const SECRET_LINE = /\b(password|passwd|secret|api[_-]?key|private[_-]?key|credential)\b/i

const LARGE_FILE_COUNT = 20
const LARGE_CHURN = 600

type Detector = (files: ReadonlyArray<DiffFile>) => Signal | null

const detect_migration: Detector = (files) => {
  const hits = files.filter((f) => MIGRATION_PATH.test(f.path)).map((f) => f.path)
  if (hits.length === 0) return null
  return {
    id: 'db-migration',
    severity: 'high',
    detail: 'Database migration or schema change. Data-shape changes are hard to reverse.',
    paths: hits,
  }
}

const detect_auth_change: Detector = (files) => {
  const hits = files
    .filter((f) => !TEST_PATH.test(f.path) && f.added_lines.some((l) => AUTH_LINE.test(l.content)))
    .map((f) => f.path)
  if (hits.length === 0) return null
  return {
    id: 'auth-change',
    severity: 'high',
    detail: 'Touches authentication, authorization, or tenant-isolation logic.',
    paths: hits,
  }
}

const detect_secret_material: Detector = (files) => {
  const hits = files
    .filter((f) => f.added_lines.some((l) => SECRET_LINE.test(l.content)))
    .map((f) => f.path)
  if (hits.length === 0) return null
  return {
    id: 'secret-material',
    severity: 'high',
    detail: 'Adds lines that mention credentials or secret material. Review for exposure.',
    paths: hits,
  }
}

const detect_dependency_change: Detector = (files) => {
  const hits = files.filter((f) => DEPENDENCY_PATH.test(f.path)).map((f) => f.path)
  if (hits.length === 0) return null
  return {
    id: 'dependency-change',
    severity: 'medium',
    detail: 'Changes dependency manifests or lockfiles (supply-chain surface).',
    paths: hits,
  }
}

const detect_infra_change: Detector = (files) => {
  const hits = files.filter((f) => INFRA_PATH.test(f.path)).map((f) => f.path)
  if (hits.length === 0) return null
  return {
    id: 'infra-change',
    severity: 'medium',
    detail: 'Changes CI, deployment, or infrastructure configuration.',
    paths: hits,
  }
}

const detect_large_change: Detector = (files) => {
  const churn = files.reduce((n, f) => n + f.added_lines.length + f.removed_count, 0)
  if (files.length < LARGE_FILE_COUNT && churn < LARGE_CHURN) return null
  return {
    id: 'large-change',
    severity: 'medium',
    detail: `Large change set (${String(files.length)} files, ~${String(churn)} changed lines). Blast radius grows with size.`,
    paths: [],
  }
}

const detect_no_tests: Detector = (files) => {
  const code_touched = files.some((f) => CODE_PATH.test(f.path) && !TEST_PATH.test(f.path))
  const tests_touched = files.some((f) => TEST_PATH.test(f.path))
  if (!code_touched || tests_touched) return null
  return {
    id: 'no-tests',
    severity: 'medium',
    detail: 'Code changed without any accompanying test changes.',
    paths: [],
  }
}

const DETECTORS: ReadonlyArray<Detector> = [
  detect_migration,
  detect_auth_change,
  detect_secret_material,
  detect_dependency_change,
  detect_infra_change,
  detect_large_change,
  detect_no_tests,
]

export function detect_signals(files: ReadonlyArray<DiffFile>): ReadonlyArray<Signal> {
  return DETECTORS.map((detect) => detect(files)).filter((s): s is Signal => s !== null)
}
