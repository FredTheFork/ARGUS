/**
 * tests/run.mjs — run every suite and report.
 *
 *   node tests/run.mjs        (npm test)
 *
 * Exits non-zero if anything failed, so it can gate a deploy.
 */
import { results } from './harness.mjs';

console.log('ARGUS test suite\n');

await import('./logic.mjs');
await import('./assets.mjs');
await import('./boot.mjs');
await import('./pwa.mjs');

const { pass, fail, failures } = results;
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nfailures:');
  for (const name of failures) console.log(`  · ${name}`);
}
process.exit(fail ? 1 : 0);
