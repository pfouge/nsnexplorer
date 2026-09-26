#!/usr/bin/env node
// ingest/publog/fetch.mjs
// Downloads the PUB LOG bulk data ZIPs (IDENTIFICATION.zip, REFERENCE.zip,
// CAGE.zip, CHARACTERISTICS.zip) and unzips them for load.mjs to read. Run
// monthly from GitHub Actions (US runners).
//
// CLI:
//   node fetch.mjs --out dir/
//   node fetch.mjs --out dir/ --files IDENTIFICATION.zip,CAGE.zip

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const BASE_URL =
  'https://www.dla.mil/Portals/104/Documents/InformationOperations/LogisticsInformationServices/FOIA/PUBLOG/';

export const DEFAULT_FILES = [
  'IDENTIFICATION.zip',
  'REFERENCE.zip',
  'CAGE.zip',
  'CHARACTERISTICS.zip',
];

function parseArgs(argv) {
  const args = { out: undefined, files: DEFAULT_FILES };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--files') args.files = argv[++i].split(',').map((s) => s.trim());
  }
  if (!args.out) throw new Error('fetch.mjs: --out is required');
  return args;
}

async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetch.mjs: HTTP ${res.status} downloading ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(destPath, buf);
}

async function unzip(zipPath, destDir) {
  // Relies on the `unzip` binary being present on the runner (it is on
  // ubuntu-latest). -o overwrites without prompting.
  await execFileAsync('unzip', ['-o', zipPath, '-d', destDir]);
}

export async function fetchAndUnzip({ out, files = DEFAULT_FILES }) {
  await mkdir(out, { recursive: true });
  const extracted = [];
  for (const filename of files) {
    const url = `${BASE_URL}${filename}`;
    const zipPath = path.join(out, filename);
    console.log(`fetch.mjs: downloading ${url}`);
    await downloadFile(url, zipPath);
    console.log(`fetch.mjs: unzipping ${zipPath}`);
    await unzip(zipPath, out);
    extracted.push(zipPath);
  }
  return extracted;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const extracted = await fetchAndUnzip(args);
  console.log(`fetch.mjs: downloaded and unzipped ${extracted.length} file(s) into ${args.out}`);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
