// Test-only preload (node --import): sends every request for a *.test host to the fixture web on
// 127.0.0.1:$FIXTURE_PORT, as if DNS pointed there. Used by the local end-to-end run.
import { virtualFetch } from './sites.mjs';

if (process.env.FIXTURE_PORT) globalThis.fetch = virtualFetch(Number(process.env.FIXTURE_PORT), globalThis.fetch);
