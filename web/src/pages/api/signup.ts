// POST /api/signup — inserts an email-capture signup into pub.signups.
// Runs on the Cloudflare Pages Function (Astro on-demand endpoint). Replaces
// the former functions/api/signup.js: the Cloudflare adapter owns the Function
// bundle, so Pages' functions/ directory is no longer used.
//
// pub.signups(email text, hook text CHECK IN ('shop_alerts','overpay_digest'),
//              fsc_interest char(4)[], created_at timestamptz)
import type { APIRoute } from 'astro';
import { openSql } from '../../lib/nsn-page';
import { databaseUrlFrom } from '../../lib/runtime-env';

export const prerender = false;

const VALID_HOOKS = new Set(['shop_alerts', 'overpay_digest']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Postgres array literal, e.g. {5331,5330}. Sent as text and cast to
// char(4)[] in the INSERT so it does not depend on driver type inference.
function parseFscInterest(raw: unknown): string | null {
  if (!raw) return null;
  const codes = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[0-9]{4}$/.test(s));
  return codes.length > 0 ? `{${codes.join(',')}}` : null;
}

async function readFields(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return (await request.json()) as Record<string, unknown>;
  const form = await request.formData();
  return Object.fromEntries(form.entries());
}

export const POST: APIRoute = async (ctx) => {
  const { request } = ctx;
  let fields: Record<string, unknown>;
  try {
    fields = await readFields(request);
  } catch {
    return jsonResponse({ ok: false, error: 'Could not read form data.' }, 400);
  }

  const email = String(fields.email || '').trim().toLowerCase();
  const hook = String(fields.hook || '').trim();
  const fscInterest = parseFscInterest(fields.fsc_interest);

  if (!EMAIL_RE.test(email)) return jsonResponse({ ok: false, error: 'Enter a valid email address.' }, 400);
  if (!VALID_HOOKS.has(hook)) return jsonResponse({ ok: false, error: 'Unknown signup type.' }, 400);

  const databaseUrl = databaseUrlFrom(ctx);
  if (!databaseUrl) return jsonResponse({ ok: false, error: 'Signup is not configured in this environment.' }, 503);

  const sql = openSql(databaseUrl);
  try {
    await sql`
      INSERT INTO pub.signups (email, hook, fsc_interest)
      VALUES (${email}, ${hook}, ${fscInterest}::char(4)[])
      ON CONFLICT (email, hook) DO NOTHING
    `;
  } catch (err) {
    console.error('signup insert failed:', err instanceof Error ? err.message : err);
    return jsonResponse({ ok: false, error: 'Could not save signup.' }, 500);
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }

  const accept = request.headers.get('accept') || '';
  if (accept.includes('text/html')) {
    return Response.redirect(new URL('/?signup=ok', request.url).toString(), 303);
  }
  return jsonResponse({ ok: true }, 200);
};

export const GET: APIRoute = async () => jsonResponse({ ok: false, error: 'Use POST.' }, 405);
