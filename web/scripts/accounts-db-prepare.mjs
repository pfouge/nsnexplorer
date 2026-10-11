#!/usr/bin/env node
// Makes a throwaway copy of a local database and puts the accounts layer on it:
//   node web/scripts/accounts-db-prepare.mjs <source-db-url> <new-db-name>
// Copies the source (CREATE DATABASE ... TEMPLATE), adds the Supabase stand-ins
// (web/scripts/supabase-stubs.sql) and applies db/migrations through db/migrate.mjs.
// Prints the new database's URL. Refuses anything that looks like a hosted database.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import postgres from "postgres";

const [src, name] = process.argv.slice(2);
if (!src || !name || !/^[a-z0-9_]+$/.test(name)) { console.error("usage: node web/scripts/accounts-db-prepare.mjs <source-db-url> <new-db-name>"); process.exit(2); }
if (!/(127\.0\.0\.1|localhost)/.test(src)) { console.error("refusing: the source must be a local database"); process.exit(2); }

const u = new URL(src);
const srcDb = u.pathname.slice(1);
const admin = postgres(Object.assign(new URL(src), { pathname: "/postgres" }).toString(), { max: 1, onnotice: () => {} });
await admin.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname in ('${name}') and pid <> pg_backend_pid()`);
await admin.unsafe(`drop database if exists ${name}`);
await admin.unsafe(`create database ${name} template ${srcDb}`);
await admin.end();

const target = new URL(src); target.pathname = `/${name}`;
const db = postgres(target.toString(), { max: 1, onnotice: () => {} });
await db.unsafe(readFileSync(new URL("./supabase-stubs.sql", import.meta.url), "utf8"));
await db.end();

const mig = spawnSync("node", ["db/migrate.mjs", `--database-url=${target}`], { cwd: new URL("../../", import.meta.url).pathname, encoding: "utf8" });
if (mig.status !== 0) { console.error(mig.stdout, mig.stderr); process.exit(1); }
console.log(target.toString());
