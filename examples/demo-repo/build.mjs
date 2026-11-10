// Demo build: slow on a cold cache, fast on a warm one.
// If .cache/out.txt exists the work is already done; otherwise this
// script simulates 400 ms of real work and writes the cache file.
// 400 ms (not 150) so the cold-vs-warm gap dwarfs Node startup time
// and stays decisive on loaded CI machines.
import fs from 'node:fs';
import path from 'node:path';

const cacheDir = path.join(process.cwd(), '.cache');
const out = path.join(cacheDir, 'out.txt');
if (fs.existsSync(out)) {
  console.log('cache hit');
} else {
  const until = Date.now() + 400;
  while (Date.now() < until) { /* simulate work the cache would skip */ }
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(out, 'built\n');
  console.log('cache miss');
}
