#!/usr/bin/env node
// Starts the fixture web and the mock Anthropic endpoint on fixed ports for a local end-to-end run:
//   node ingest/supplier-web/fixtures/serve.mjs 4701 4702
// then run.mjs with FIXTURE_PORT=4701 ANTHROPIC_BASE_URL=http://127.0.0.1:4702 and
// node --import ./ingest/supplier-web/fixtures/virtual-hosts.mjs (see REPORT.md for the full command).
import { startFixtureSites, startMockAnthropic } from './sites.mjs';

const [webPort, aiPort] = process.argv.slice(2).map(Number);
await startFixtureSites(undefined, webPort);
await startMockAnthropic(aiPort);
console.log(`fixture web on ${webPort}, mock anthropic on ${aiPort}`);
