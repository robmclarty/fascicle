/**
 * The search worker: one search, run off the main thread so the turn's
 * abort and the time budget can terminate it mid-match.
 *
 * `search.ts` starts this file by URL and nothing imports it. It's only
 * the shell that hands the thread's job to `search_files` and posts the
 * result back, because Stryker can't switch on a mutant in code that runs
 * inside a worker thread: every decision lives in `search.ts`, where the
 * tests call it on the main thread. A failed search throws here, and the
 * thread's `error` event carries the error back.
 */

import { parentPort, workerData } from 'node:worker_threads'
import { search_files } from './search.js'

// The rule is for a window's postMessage, which names the origin it sends
// to; a worker's MessagePort has only the one thread on its other end.
// oxlint-disable-next-line unicorn/require-post-message-target-origin
parentPort?.postMessage(await search_files(workerData))
