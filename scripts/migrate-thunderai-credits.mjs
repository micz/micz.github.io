#!/usr/bin/env node
// One-time migration of content/thunderbird-addon-thunderai/languages.json from the old credits
// format (an HTML string, plus `synced_contributors`) to the structured one read by
// sync-thunderai-languages.mjs and lang_list_weblate. Plain Node, no dependencies.
//
// Usage:
//   node scripts/migrate-thunderai-credits.mjs [--file <path>] [--dry-run]
//
// For every entry:
// - each item of the `credits` string becomes { name, url?, github?, weblate? }: the link text is
//   the name, the href the url, and a GitHub or Weblate profile link also gives the login;
// - "Generated automatically" becomes { "generated": true }, moved to the end;
// - each `synced_contributors` record fills the keys its item does not have (url, github,
//   weblate, first); a record with no item was removed by hand and becomes a { ..., "hidden":
//   true } item, so the sync does not add it again. `synced_contributors` is then dropped.
// Entries already migrated are left as they are, so running it twice changes nothing.
//
// Prints what it did. Exit codes: 0 ok, 1 bad input, 2 file not canonical.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_FILE = resolve(dirname(fileURLToPath(import.meta.url)),
    '../content/thunderbird-addon-thunderai/languages.json');

const collator = new Intl.Collator('en', { sensitivity: 'base' });

function fail(code, msg) {
    console.error(`error: ${msg}`);
    process.exit(code);
}

function parseArgs(argv) {
    const opts = { dryRun: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--dry-run') opts.dryRun = true;
        else if (argv[i] === '--file' && i + 1 < argv.length) opts.file = argv[++i];
        else fail(1, `unknown argument ${argv[i]}`);
    }
    return opts;
}

function unescapeHtml(text) {
    return text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// "https://GitHub.com/Foo/" -> "github.com/foo"
const normUrl = (url) => url ? url.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '') : null;
const sameName = (a, b) => !!(a && b) && collator.compare(a, b) === 0;
const sameLogin = (a, b) => !!(a && b) && a.toLowerCase() === b.toLowerCase();

// Items of a credits string. Commas inside a link do not split it.
function parseCredits(html) {
    return (html ?? '').split(/,(?![^<]*<\/a>)/).map((s) => s.trim()).filter(Boolean).map((raw) => {
        const name = unescapeHtml(raw.replace(/<[^>]*>/g, '')).trim();
        const href = raw.match(/href="([^"]*)"/)?.[1];
        if (!href && /^generated automatically$/i.test(name)) return { generated: true };
        const item = { name };
        if (href) {
            item.url = unescapeHtml(href);
            const github = item.url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/?$/i)?.[1];
            const weblate = item.url.match(/^https?:\/\/hosted\.weblate\.org\/user\/([^/?#]+)\/?$/i)?.[1];
            if (github) item.github = github;
            if (weblate) item.weblate = weblate;
        }
        return item;
    });
}

const recordUrls = (r) => [r.url,
    r.github && `https://github.com/${r.github}`,
    r.weblate && `https://hosted.weblate.org/user/${r.weblate}/`].filter(Boolean).map(normUrl);

const isItemOf = (item, r) => sameLogin(item.github, r.github) || sameLogin(item.weblate, r.weblate)
    || (item.url && recordUrls(r).includes(normUrl(item.url))) || sameName(item.name, r.name);

function migrate(entry) {
    const items = parseCredits(entry.credits);
    const hidden = [];
    for (const r of entry.synced_contributors ?? []) {
        const item = items.find((i) => !i.generated && isItemOf(i, r));
        const target = item ?? { name: r.name };
        for (const k of ['url', 'github', 'weblate', 'first']) if (!(k in target) && r[k]) target[k] = r[k];
        if (!item) { target.hidden = true; hidden.push(target); }
    }
    const generated = items.some((i) => i.generated);
    entry.credits = [...items.filter((i) => !i.generated), ...hidden, ...(generated ? [{ generated: true }] : [])];
    delete entry.synced_contributors;
    return { lang_code: entry.lang_code, shown: items.filter((i) => !i.generated).map((i) => i.name),
        hidden: hidden.map((i) => i.name), generated };
}

const opts = parseArgs(process.argv.slice(2));
const file = resolve(opts.file ?? DEFAULT_FILE);
let text;
try { text = readFileSync(file, 'utf8'); } catch (e) { fail(1, `cannot read ${file}: ${e.message}`); }
const eol = text.includes('\r\n') ? '\r\n' : '\n';
const finalNewline = /\r?\n$/.test(text);
const entries = JSON.parse(text);
if (!Array.isArray(entries)) fail(1, `${file} is not an array`);
// Rewriting goes through JSON.stringify, so refuse a file it would not reproduce byte for byte.
if (JSON.stringify(entries, null, 4) !== text.replace(/\r\n/g, '\n').replace(/\n$/, '')) {
    fail(2, `${file} is not in canonical 4-space JSON.stringify format; refusing to rewrite it`);
}

const migrated = entries
    .filter((e) => e.lang_code && (!Array.isArray(e.credits) || 'synced_contributors' in e))
    .map((e) => {
        if (Array.isArray(e.credits)) fail(1, `"${e.lang_code}" has structured credits and synced_contributors; fix it by hand`);
        return migrate(e);
    });

if (migrated.length && !opts.dryRun) {
    writeFileSync(file, JSON.stringify(entries, null, 4).replace(/\n/g, eol) + (finalNewline ? eol : ''), 'utf8');
}
console.log(JSON.stringify({ file, dry_run: opts.dryRun, migrated }, null, 2));
if (!migrated.length) console.error('Nothing to migrate.');
