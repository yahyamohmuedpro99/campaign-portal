// Downloads and verifies the seed bundle into ./data (git-ignored).
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';

const URL_ = 'https://dispatcher-production-72fc.up.railway.app/data/SivIPYk5jesN2MTvMX9aEA/vg-growth-engineer-seed.zip';
const SHA = '4961a25b151ca13ac56089ca46b94def6074c315445ec193c7bf87060683d35c';

await mkdir('data', { recursive: true });
const zip = 'data/vg-growth-engineer-seed.zip';
const res = await fetch(URL_);
if (!res.ok) throw new Error(`download failed: ${res.status}`);
await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));

const actual = createHash('sha256').update(await readFile(zip)).digest('hex');
if (actual !== SHA) throw new Error(`checksum mismatch\n  expected ${SHA}\n  actual   ${actual}`);
console.log(`checksum ok: ${actual}`);

await rm('data/seed', { recursive: true, force: true });
execFileSync('unzip', ['-q', zip, '-d', 'data/seed']);
console.log('extracted to data/seed');
