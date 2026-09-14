// Concatenates the migrations into a single schema.sql, which the brief asks for.
import { readdir, readFile, writeFile } from 'node:fs/promises';

const dir = 'supabase/migrations';
const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

const header = `-- =====================================================================================
-- schema.sql
--
-- Generated from supabase/migrations by \`pnpm schema:build\`. Do not edit by hand: add a
-- migration instead, so that what runs locally, in CI and in production is the same
-- sequence of statements.
--
-- Applying this file to an empty Postgres database reproduces the portal's schema in
-- full: tables, row-level security policies, grants, and every function.
--
-- Generated from ${files.length} migrations.
-- =====================================================================================

`;

const body = [];
for (const f of files) {
  body.push(`\n-- ${'='.repeat(85)}\n-- ${f}\n-- ${'='.repeat(85)}\n`);
  body.push(await readFile(`${dir}/${f}`, 'utf8').then((s) => s.trimEnd()));
  body.push('\n');
}

await writeFile('schema.sql', header + body.join('\n'));
console.log(`schema.sql written from ${files.length} migrations`);
