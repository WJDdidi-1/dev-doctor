/**
 * File-kind facts shared by the context scan and the secret scan.
 *
 * A leaf module on purpose: lib/secrets.mjs needs these two facts and
 * lib/context.mjs needs the secret rules, so if they lived in
 * context.mjs the two modules imported each other and importing
 * secrets.mjs on its own crashed — context.mjs builds its
 * RULE_LABELS map at module top level while SECRET_RULES is still
 * in its temporal dead zone ("Cannot access 'SECRET_RULES' before
 * initialization"). Nothing in this file imports anything, so the
 * cycle cannot come back.
 */

/** Lockfile basenames: their token cost is real but they are generated. */
export const LOCKFILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);

const TEMPLATE = /\.(example|sample|template|dist)$/i;

/** `.env.example`, `config.sample`, `foo.template` — safe to share, never a secret. */
export function isTemplateFile(basename) {
  return TEMPLATE.test(basename);
}
