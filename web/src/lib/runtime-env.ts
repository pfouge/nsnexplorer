// Resolves the Postgres connection string for request-time code (NSN pages,
// /api/*) in order of preference: the Hyperdrive binding on the Pages
// project (production and preview), a DATABASE_URL Pages variable, then the
// build/dev environment variable (astro dev, wrangler dev with a .dev.vars).
import type { APIContext, AstroGlobal } from 'astro';

type RuntimeEnv = { HYPERDRIVE?: { connectionString: string }; DATABASE_URL?: string };

export function databaseUrlFrom(ctx: Pick<AstroGlobal | APIContext, 'locals'>): string | undefined {
  const env = ((ctx.locals as { runtime?: { env?: RuntimeEnv } }).runtime?.env ?? {}) as RuntimeEnv;
  return env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL ?? import.meta.env.DATABASE_URL ?? undefined;
}
