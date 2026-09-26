#!/usr/bin/env node
// ingest/assist/probe.mjs
// One-shot probe: can a US runner script ASSIST Quick Search end-to-end?
//   1. GET quicksearch.dla.mil (session cookies)
//   2. POST the search form for a known spec (MIL-DTL-83461)
//   3. Find the qsDocDetails.aspx?ident_number=... link
//   4. GET the details page, extract the ImageRedirector token URL
//   5. GET the PDF; report status + first bytes (%PDF magic)
// Writes findings to ingest/assist/probe-findings.json (committed by the
// workflow). Etiquette: 1.5s between requests, identifying User-Agent.

import { mkdir, writeFile } from 'node:fs/promises';

const BASE = 'https://quicksearch.dla.mil';
const UA = 'nsnexplorer.com ingest (contact: hello@nsnexplorer.com)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Jar {
  constructor() { this.c = new Map(); }
  absorb(h) {
    const sc = typeof h.getSetCookie === 'function' ? h.getSetCookie() : (h.get('set-cookie') ? [h.get('set-cookie')] : []);
    for (const raw of sc) {
      const f = raw.split(';')[0]; const i = f.indexOf('=');
      if (i > 0) this.c.set(f.slice(0, i).trim(), f.slice(i + 1).trim());
    }
  }
  header() { return [...this.c.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
}

async function get(jar, url, opts = {}, chain = null) {
  const headers = { 'User-Agent': UA, ...(opts.headers || {}) };
  if (jar.header()) headers.Cookie = jar.header();
  const res = await fetch(url, { ...opts, headers, redirect: 'manual' });
  jar.absorb(res.headers);
  if (chain) chain.push({ url: url.slice(0, 140), status: res.status, location: (res.headers.get('location') || '').slice(0, 140) });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    await res.arrayBuffer();
    return get(jar, new URL(loc, url).toString(), {}, chain);
  }
  return res;
}

function hiddenFields(html) {
  const fields = {};
  const re = /<input\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const a = m[1];
    const type = (a.match(/type\s*=\s*"([^"]*)"/i) || [])[1] || '';
    if (type.toLowerCase() !== 'hidden') continue;
    const name = (a.match(/name\s*=\s*"([^"]*)"/i) || [])[1];
    if (!name) continue;
    fields[name] = ((a.match(/value\s*=\s*"([^"]*)"/i) || [])[1] || '')
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  }
  return fields;
}

async function main() {
  await mkdir('ingest/assist', { recursive: true });
  const jar = new Jar();
  const findings = { at: new Date().toISOString(), steps: [] };
  const note = (step, data) => { findings.steps.push({ step, ...data }); console.log(step, JSON.stringify(data).slice(0, 300)); };

  // 1. Landing page + form fields.
  const res1 = await get(jar, `${BASE}/qsSearch.aspx`);
  const html1 = await res1.text();
  note('landing', { status: res1.status, bytes: html1.length });
  const fields = hiddenFields(html1);
  note('hidden-fields', { names: Object.keys(fields).slice(0, 12) });

  // Find the doc-id input + search button names from the form markup.
  const inputNames = [...html1.matchAll(/<input\b[^>]*name\s*=\s*"([^"]*)"[^>]*>/gi)].map((m) => m[1]);
  const textInputs = [...html1.matchAll(/<input\b[^>]*type\s*=\s*"text"[^>]*name\s*=\s*"([^"]*)"[^>]*>/gi)].map((m) => m[1]);
  note('inputs', { textInputs, all: inputNames.slice(0, 20) });

  // 2. POST search for MIL-DTL-83461. Try the likely doc-number field.
  const docField = textInputs.find((n) => /doc|num|search/i.test(n)) || textInputs[0];
  const buttonName = inputNames.find((n) => /but|search|submit/i.test(n) && /<input\b[^>]*name\s*=\s*"SUB"/.test('')) || null;
  await sleep(1500);
  const body = new URLSearchParams({ ...fields, [docField]: 'MIL-DTL-83461' });
  // Include the first submit-type input if present.
  const submit = (html1.match(/<input\b[^>]*type\s*=\s*"submit"[^>]*name\s*=\s*"([^"]*)"[^>]*value\s*=\s*"([^"]*)"/i) || []);
  if (submit[1]) body.set(submit[1], submit[2] || 'Submit');
  const res2 = await get(jar, `${BASE}/qsSearch.aspx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const html2 = await res2.text();
  const detailsLinks = [...html2.matchAll(/qsDocDetails\.aspx\?ident_number=(\d+)/gi)].map((m) => m[1]);
  note('search-post', { status: res2.status, bytes: html2.length, docField, submitName: submit[1] || null, identNumbers: [...new Set(detailsLinks)].slice(0, 5) });

  // Known Distribution-A public standards (stable ident_numbers). The
  // search POST returns column indices, not idents, so pin these.
  const ident = '36064'; // MIL-STD-962
  note('pinned-ident', { ident, doc: 'MIL-STD-962' });

  // 3. Details page -> PDF token.
  await sleep(1500);
  const res3 = await get(jar, `${BASE}/qsDocDetails.aspx?ident_number=${ident}`);
  const html3 = await res3.text();
  const title = (html3.match(/<title>([^<]*)<\/title>/i) || [])[1];
  const tokens = [...html3.matchAll(/ImageRedirector\.aspx\?token=([^'"&]+)/gi)].map((m) => m[1]);
  const pdfAnchors = [...html3.matchAll(/href\s*=\s*"([^"]*(?:\.pdf|Image|token|Redirect)[^"]*)"/gi)].map((m) => m[1].slice(0, 120));
  const spawnCalls = [...html3.matchAll(/spawnPDFWindow\('([^']+)'/gi)].map((m) => m[1].slice(0, 120));
  note('details', { status: res3.status, bytes: html3.length, title, tokenCount: tokens.length, tokenSample: tokens[0] ? tokens[0].slice(0, 40) : null, pdfAnchors: pdfAnchors.slice(0, 6), spawnCalls: spawnCalls.slice(0, 6) });

  // 4. Fetch the PDF via the first token.
  if (tokens.length > 0) {
    await sleep(1500);
    const res4 = await get(jar, `${BASE}/ImageRedirector.aspx?token=${tokens[0]}`, {
      headers: { Referer: `${BASE}/qsDocDetails.aspx?ident_number=${ident}` },
    });
    const buf = Buffer.from(await res4.arrayBuffer());
    const magic = buf.subarray(0, 5).toString('latin1');
    note('pdf-fetch', {
      status: res4.status,
      contentType: res4.headers.get('content-type'),
      bytes: buf.length,
      isPdf: magic === '%PDF-',
      magic,
      bodySnippet: magic === '%PDF-' ? null : buf.toString('utf8').slice(0, 900),
    });
    // The redirector serves a self-posting form whose onload clicks a
    // LinkButton (__doPostBack). Emulate the click: POST the form's
    // hidden fields + __EVENTTARGET=LinkButton back to the token URL.
    if (magic !== '%PDF-') {
      const html4 = buf.toString('utf8');
      const action = (html4.match(/<form[^>]*action\s*=\s*"([^"]*)"/i) || [])[1] || `./ImageRedirector.aspx?token=${tokens[0]}`;
      const evTarget = (html4.match(/__doPostBack\('([^']+)'/) || [])[1] || 'LinkButton';
      const f4 = hiddenFields(html4);
      await sleep(1500);
      const chain = [];
      const res5 = await get(jar, new URL(action.replace(/&amp;/g, '&'), `${BASE}/`).toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: `${BASE}/ImageRedirector.aspx?token=${tokens[0]}`,
        },
        body: new URLSearchParams({ ...f4, __EVENTTARGET: evTarget, __EVENTARGUMENT: '' }).toString(),
      }, chain);
      const buf5 = Buffer.from(await res5.arrayBuffer());
      const magic5 = buf5.subarray(0, 5).toString('latin1');
      note('pdf-postback', {
        action: action.slice(0, 80),
        chain,
        evTarget,
        status: res5.status,
        contentType: res5.headers.get('content-type'),
        bytes: buf5.length,
        isPdf: magic5 === '%PDF-',
        bodySnippet: magic5 === '%PDF-' ? null : buf5.toString('utf8').slice(0, 500),
      });
    }
  } else {
    note('pdf-fetch', { skipped: 'no ImageRedirector tokens found on details page' });
  }

  await writeFile('ingest/assist/probe-findings.json', JSON.stringify(findings, null, 2) + '\n');
  console.log('probe complete');
}

main().catch((err) => { console.error(err); process.exit(1); });
