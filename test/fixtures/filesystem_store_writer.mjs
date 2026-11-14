/**
 * A process that adds one to a counter in a `filesystem_store`, over and
 * over, with a conditional write each time.
 *
 * Run as `node filesystem_store_writer.mjs <root_dir> <times>`. Several of
 * these at once are the writers of several processes on one machine, which
 * one test process can't be. Every increment reads the counter with its
 * version and writes on that version until a write lands, so the counter
 * ends at the total only when no process's conditional write went over
 * another's.
 */

import { filesystem_store } from '../../src/adapters/filesystem_store.ts';

const [root_dir = '', times = '0'] = process.argv.slice(2);
const store = filesystem_store({ root_dir });

/**
 * Add one to the counter, reading and writing again for as long as another
 * writer gets there first.
 */
async function increment() {
  for (;;) {
    const read = await store.get_versioned('counter');
    const next = { n: (read?.value?.n ?? 0) + 1 };
    if (await store.set_if('counter', next, read?.version ?? null)) return;
  }
}

for (let i = 0; i < Number(times); i += 1) await increment();
