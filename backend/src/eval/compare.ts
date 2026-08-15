import fs from 'node:fs';
import path from 'node:path';

/**
 * Paired bootstrap comparison of two saved eval runs.
 *
 * Two systems evaluated on the SAME queries produce paired data: they tend to
 * succeed and fail on the same items. Comparing their marginal confidence
 * intervals throws that pairing away and is badly over-conservative. Two
 * systems can differ on every single query and still show overlapping marginals.
 *
 * The right test resamples QUERIES and recomputes the DIFFERENCE each time. If
 * the 95% interval of the difference excludes zero, the difference is real at
 * p < 0.05.
 *
 * Usage: tsx src/eval/compare.ts a.json b.json
 */

const here = path.dirname(new URL(import.meta.url).pathname);
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(here, f), 'utf8'));

function pairedCI(a: number[], b: number[], iterations = 10000): [number, number, number] {
  const diffs = a.map((v, i) => b[i] - v);
  const mean = diffs.reduce((x, y) => x + y, 0) / diffs.length;
  let seed = 987654321;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const means: number[] = [];
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (let i = 0; i < diffs.length; i++) sum += diffs[Math.floor(rnd() * diffs.length)];
    means.push(sum / diffs.length);
  }
  means.sort((x, y) => x - y);
  return [mean, means[Math.floor(iterations * 0.025)], means[Math.floor(iterations * 0.975)]];
}

const [fa, fb] = process.argv.slice(2).filter((a) => a.endsWith('.json'));
if (!fa || !fb) throw new Error('usage: compare.ts <a.json> <b.json>');
const A = load(fa);
const B = load(fb);
if (A.ids.length !== B.ids.length) throw new Error('runs have different case counts');

const label = (r: any) => `${r.mode} k=${r.k}${r.rerank ? ' +rerank' : ''}`;
console.log(`Paired comparison on ${A.file}, n=${A.ids.length}`);
console.log(`  A = ${label(A)}\n  B = ${label(B)}\n`);

for (const metric of ['strictHit', 'chapterHit', 'strictRR', 'chapterRR'] as const) {
  const [mean, lo, hi] = pairedCI(A[metric], B[metric]);
  const sig = lo > 0 || hi < 0 ? 'SIGNIFICANT' : 'not significant';
  const scale = metric.endsWith('Hit') ? 100 : 1;
  const unit = metric.endsWith('Hit') ? 'pp' : '';
  console.log(
    `  ${metric.padEnd(11)} B−A = ${(mean * scale).toFixed(scale === 100 ? 1 : 4)}${unit}` +
      `  95% CI [${(lo * scale).toFixed(scale === 100 ? 1 : 4)}, ${(hi * scale).toFixed(scale === 100 ? 1 : 4)}]` +
      `  ${sig}`,
  );
}
