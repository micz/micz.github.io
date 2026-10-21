#!/usr/bin/env node
// Syncs content/thunderbird-addon-thunderai/languages.json with the locales sent by the
// ThunderAI repo (repository_dispatch "thunderai-languages"). Plain Node, no dependencies.
//
// Usage:
//   node scripts/sync-thunderai-languages.mjs --mode in_progress --locales ko,uk [options]
//   node scripts/sync-thunderai-languages.mjs --payload client_payload.json [options]
//
// Options:
//   --mode in_progress|release   overrides payload.mode
//   --locales a,b,c              overrides payload.locales (array or comma-separated string)
//   --contributors '<json>'      {"ko": [{ name, email, github, weblate, url }, ...]}, overrides
//                                payload.contributors (old format ["Name", ...] | "Name, Name" still works)
//   --payload <file>             JSON file with { mode, locales, contributors?, ref, url }
//   --file <path>                languages.json to edit (default: the ThunderAI one in this repo)
//   --baseline <path>            languages.json to compare against for the PR text (default: the
//                                file as it was before this run)
//   --source-url <url>           link shown in the PR body (default: payload.url)
//   --summary <path>             also write the JSON summary to this file
//   --pr-body <path>             write the Markdown PR body to this file
//   --dry-run                    compute and print the summary, write nothing
//
// Contributors only fill the credits of entries this run adds; the PR is where they get approved.
// Credits already in the file are hand-made and always win: they are never rewritten. Emails are
// used only as the key to merge duplicates and never reach the file, the PR or the output.
//
// The summary is printed to stdout as JSON. Exit codes: 0 ok, 1 bad input, 2 file not canonical.
// When GITHUB_OUTPUT is set, "changed" and "pr_title" are appended to it.

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_FILE = resolve(dirname(fileURLToPath(import.meta.url)),
    '../content/thunderbird-addon-thunderai/languages.json');
const CODE_RE = /^[a-z]{2,3}([_-][A-Za-z]{2,4})?$/;
const MODES = ['in_progress', 'release'];

const collator = new Intl.Collator('en', { sensitivity: 'base' });
const enNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });

function fail(code, msg) {
    console.error(`error: ${msg}`);
    process.exit(code);
}

function parseArgs(argv) {
    const opts = { dryRun: false };
    const valued = ['mode', 'locales', 'contributors', 'payload', 'file', 'baseline',
        'source-url', 'summary', 'pr-body'];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--dry-run') { opts.dryRun = true; continue; }
        const name = arg.replace(/^--/, '');
        if (!arg.startsWith('--') || !valued.includes(name)) fail(1, `unknown argument ${arg}`);
        if (i + 1 >= argv.length) fail(1, `${arg} needs a value`);
        opts[name] = argv[++i];
    }
    return opts;
}

function readJson(path, what) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
        fail(1, `cannot read ${what} ${path}: ${e.message}`);
    }
}

function toList(value) {
    if (value == null) return [];
    if (Array.isArray(value)) return value.map(String);
    return String(value).split(',');
}

// "zh_Hans" -> "zh-Hans", "pt-br" -> "pt-BR"
function toBcp47(code) {
    const [lang, sub] = code.split(/[_-]/);
    if (!sub) return lang.toLowerCase();
    if (sub.length === 2) return `${lang.toLowerCase()}-${sub.toUpperCase()}`;
    if (sub.length === 4) return `${lang.toLowerCase()}-${sub[0].toUpperCase()}${sub.slice(1).toLowerCase()}`;
    return `${lang.toLowerCase()}-${sub.toLowerCase()}`;
}

// Matching key, so "pt_BR" in the payload finds "pt-br" in the file.
const normCode = (code) => code.toLowerCase().replace('_', '-');

function hasNonLatinLetters(text) {
    return /(?=\p{L})\P{Script=Latin}/u.test(text);
}

function capitalize(text, tag) {
    const first = String.fromCodePoint(text.codePointAt(0));
    return first.toLocaleUpperCase(tag) + text.slice(first.length);
}

// Returns { lang_name, native } or null when Intl does not know the language.
function buildName(code) {
    const tag = toBcp47(code);
    let english, native;
    try {
        english = enNames.of(tag);
        native = new Intl.DisplayNames([tag], { type: 'language', fallback: 'none' }).of(tag);
    } catch {
        return null;
    }
    if (!english) return null;
    if (!native) native = english;
    native = capitalize(native, tag);
    const langName = collator.compare(english, native) === 0 ? english : `${english} - ${native}`;
    return { lang_name: langName, native, tag };
}

// Sort key of an existing entry: the native name, without the "(script)" part.
// "Bulgarian - Bǎlgarski (български)" -> "Bǎlgarski", "Esperanto" -> "Esperanto"
function sortKey(langName) {
    const parts = langName.split(' - ');
    const native = parts.length > 1 ? parts.slice(1).join(' - ') : langName;
    return native.replace(/\s*\([^)]*\)\s*$/, '');
}

// Indexes of the entries that are in order: the longest non-decreasing run by sort key.
// Entries outside it (today "Dutch - Nederlands" and "Indonesian - Bahasa Indonesia") are
// ignored when choosing where a new entry goes.
function inOrderIndexes(keys) {
    const n = keys.length;
    const len = new Array(n).fill(1);
    const prev = new Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < i; j++) {
            if (collator.compare(keys[j], keys[i]) <= 0 && len[j] + 1 > len[i]) {
                len[i] = len[j] + 1;
                prev[i] = j;
            }
        }
    }
    let best = 0;
    for (let i = 1; i < n; i++) if (len[i] > len[best]) best = i;
    const result = new Set();
    for (let i = best; i >= 0; i = prev[i]) result.add(i);
    return result;
}

// Index to insert at. Latin native names go into the native-name order; names Intl gives only
// in another script have no romanization to sort by, so they go just before the sentinel.
function insertIndex(entries, native) {
    const sentinel = entries.length - 1;
    if (hasNonLatinLetters(native)) return { index: sentinel, placement: 'before_sentinel' };
    const keys = entries.slice(0, sentinel).map((e) => sortKey(e.lang_name));
    const ordered = inOrderIndexes(keys);
    for (let i = 0; i < keys.length; i++) {
        if (ordered.has(i) && collator.compare(keys[i], native) > 0) {
            return { index: i, placement: 'sorted' };
        }
    }
    return { index: sentinel, placement: 'sorted' };
}

function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const clean = (value) => (typeof value === 'string' && value.trim()) ? value.trim() : null;

const EMAIL_RE = /<?[^\s<>@,]+@[^\s<>@,]+>?/g;

// Git names can be an email or hold one ("Kim <kim@x.org>"): drop it, and when nothing is left
// fall back to the GitHub login, then the Weblate one.
function nameWithoutEmail(item) {
    const name = clean(item.name)?.replace(EMAIL_RE, '').replace(/\(\s*\)|<\s*>/g, '').replace(/\s+/g, ' ').trim();
    return name || clean(item.github) || clean(item.weblate);
}

// One contributor as { name, email, github, weblate, url }; a plain string is the old format.
function toContributor(item) {
    if (typeof item === 'string') item = { name: item };
    if (!item || typeof item !== 'object') return null;
    const name = nameWithoutEmail(item);
    if (!name) return null;
    const url = clean(item.url)?.includes('@') ? null : clean(item.url);
    return {
        name,
        email: clean(item.email)?.toLowerCase() ?? null,
        github: clean(item.github),
        weblate: clean(item.weblate),
        url: url && /^https?:\/\//i.test(url) ? url : null,
    };
}

// Contributors of one locale, merged by email, then by GitHub login; with neither, by name.
function mergeContributors(list) {
    const people = [];
    for (const c of list.map(toContributor).filter(Boolean)) {
        const same = people.find((p) => (c.email && p.email === c.email)
            || (c.github && p.github?.toLowerCase() === c.github.toLowerCase())
            || (!c.email && !c.github && !p.email && !p.github && collator.compare(p.name, c.name) === 0));
        if (!same) { people.push(c); continue; }
        for (const k of ['email', 'github', 'weblate']) same[k] ??= c[k];
        // Same priority as ThunderAI: a GitHub profile wins over a Weblate one.
        const onGithub = (url) => /^https?:\/\/github\.com\//i.test(url ?? '');
        if (c.url && (!same.url || (onGithub(c.url) && !onGithub(same.url)))) same.url = c.url;
    }
    return people;
}

function creditsFor(contributors, code) {
    if (!contributors) return '';
    const key = Object.keys(contributors).find((k) => normCode(k) === normCode(code));
    if (!key) return '';
    const value = contributors[key];
    const list = Array.isArray(value) ? value : toList(value);
    return mergeContributors(list).map((c) => c.url
        ? `<a href="${escapeHtml(c.url)}" target="_blank">${escapeHtml(c.name)}</a>`
        : escapeHtml(c.name)).join(', ');
}

function checkEntries(entries, path) {
    if (!Array.isArray(entries) || entries.length === 0) fail(2, `${path} is not a non-empty array`);
    const last = entries[entries.length - 1];
    if (last.lang_code !== '') fail(2, `${path}: the last entry is not the sentinel (empty lang_code)`);
}

// Changes between two versions of the file, plus what a human must still fill in.
// Used for the PR, so that an update of the open PR lists everything it contains.
function describeChanges(before, after) {
    const old = new Map(before.filter((e) => e.lang_code).map((e) => [normCode(e.lang_code), e]));
    const added = [];
    const published = [];
    for (const e of after) {
        if (!e.lang_code) continue;
        const prev = old.get(normCode(e.lang_code));
        if (!prev) added.push(e);
        else if (!prev.released && e.released) published.push(e);
    }
    const needsReview = [];
    for (const e of added) {
        const native = e.lang_name.split(' - ').slice(1).join(' - ');
        if (native && hasNonLatinLetters(native) && !/\(/.test(native)) {
            needsReview.push({ lang_code: e.lang_code, issue: 'romanization',
                detail: `"${e.lang_name}": add the romanized native name, e.g. "English - Romanized (${native})"` });
        }
    }
    for (const e of [...added, ...published]) {
        if (!e.credits) {
            needsReview.push({ lang_code: e.lang_code, issue: 'credits',
                detail: `"${e.lang_name}": credits are empty${e.released ? ' (shown on the page, the language is released)' : ''}` });
        }
    }
    return { added, published, needsReview };
}

function prTitle(changes) {
    const inProgress = changes.added.some((e) => !e.released);
    const publish = changes.published.length > 0 || changes.added.some((e) => e.released);
    if (publish && inProgress) return 'ThunderAI: publish languages and new languages in progress';
    if (publish) return 'ThunderAI: publish languages';
    return 'ThunderAI: new languages in progress';
}

function prBody(changes, sourceUrl, skipped) {
    const lines = [];
    lines.push('Automatic update of `content/thunderbird-addon-thunderai/languages.json` from the ThunderAI repository.');
    if (sourceUrl) lines.push('', `Source: ${sourceUrl}`);
    lines.push('', '### Changes', '');
    for (const e of changes.added) {
        lines.push(`- Added \`${e.lang_code}\` ${e.lang_name} (${e.released ? 'released' : 'in progress'})`);
    }
    for (const e of changes.published) lines.push(`- Published \`${e.lang_code}\` ${e.lang_name}`);
    if (skipped.length) {
        lines.push('', '<details><summary>Skipped in the last event</summary>', '');
        for (const s of skipped) lines.push(`- \`${s.code}\`: ${s.reason}`);
        lines.push('', '</details>');
    }
    lines.push('', '### Needs manual review', '');
    if (changes.needsReview.length === 0) lines.push('Nothing to review.');
    for (const r of changes.needsReview) lines.push(`- [ ] \`${r.lang_code}\` ${r.issue}: ${r.detail}`);
    lines.push('', 'New entries are placed by native name; names in a non-Latin script go just before "Translate in a new language". Move them once the romanization is added.');
    return lines.join('\n') + '\n';
}

const opts = parseArgs(process.argv.slice(2));
const payload = opts.payload ? readJson(opts.payload, 'payload') : {};
const mode = opts.mode ?? payload.mode;
if (!MODES.includes(mode)) fail(1, `mode must be one of ${MODES.join(', ')} (got ${JSON.stringify(mode)})`);
const locales = toList(opts.locales ?? payload.locales).map((c) => c.trim()).filter(Boolean);
if (locales.length === 0) fail(1, 'no locales given');
let contributors = payload.contributors ?? null;
if (opts.contributors) {
    try { contributors = JSON.parse(opts.contributors); } catch (e) { fail(1, `--contributors is not JSON: ${e.message}`); }
}
const sourceUrl = opts['source-url'] ?? payload.url ?? '';

const file = resolve(opts.file ?? DEFAULT_FILE);
const text = readFileSync(file, 'utf8');
const eol = text.includes('\r\n') ? '\r\n' : '\n';
const finalNewline = /\r?\n$/.test(text);
const entries = JSON.parse(text);
checkEntries(entries, file);
// Rewriting goes through JSON.stringify, so refuse a file it would not reproduce byte for byte.
if (JSON.stringify(entries, null, 4) !== text.replace(/\r\n/g, '\n').replace(/\n$/, '')) {
    fail(2, `${file} is not in canonical 4-space JSON.stringify format; refusing to rewrite it`);
}
const original = structuredClone(entries);

const summary = { mode, file, dry_run: opts.dryRun, changed: false, added: [], published: [], skipped: [], needs_review: [] };
const seen = new Set();

for (const code of locales) {
    if (!CODE_RE.test(code)) { summary.skipped.push({ code, reason: 'invalid code' }); continue; }
    if (seen.has(normCode(code))) { summary.skipped.push({ code, reason: 'duplicate in input' }); continue; }
    seen.add(normCode(code));

    const existing = entries.find((e) => e.lang_code && normCode(e.lang_code) === normCode(code));
    if (existing) {
        if (mode === 'in_progress') {
            summary.skipped.push({ code, reason: `already present as ${existing.lang_code}` });
        } else if (existing.released) {
            summary.skipped.push({ code, reason: `already released as ${existing.lang_code}` });
        } else {
            existing.released = true;
            summary.published.push({ lang_code: existing.lang_code, lang_name: existing.lang_name });
            if (!existing.credits) {
                summary.needs_review.push({ lang_code: existing.lang_code, issue: 'credits', detail: 'credits are empty' });
            }
        }
        continue;
    }

    const name = buildName(code);
    if (!name) { summary.skipped.push({ code, reason: `no display name for ${toBcp47(code)}` }); continue; }
    const entry = { lang_name: name.lang_name, lang_code: code, released: mode === 'release', credits: creditsFor(contributors, code) };
    const { index, placement } = insertIndex(entries, name.native);
    entries.splice(index, 0, entry);
    summary.added.push({ ...entry, placement, after: index > 0 ? entries[index - 1].lang_code : null });
    if (hasNonLatinLetters(name.native)) {
        summary.needs_review.push({ lang_code: code, issue: 'romanization',
            detail: `native name "${name.native}" has no romanization; entry placed before the sentinel` });
    }
    if (!entry.credits) {
        summary.needs_review.push({ lang_code: code, issue: 'credits', detail: 'no contributors given, credits are empty' });
    }
}

summary.changed = summary.added.length > 0 || summary.published.length > 0;

const baseline = opts.baseline ? readJson(opts.baseline, 'baseline') : original;
const changes = describeChanges(baseline, entries);
summary.pr_title = prTitle(changes);

if (summary.changed && !opts.dryRun) {
    writeFileSync(file, JSON.stringify(entries, null, 4).replace(/\n/g, eol) + (finalNewline ? eol : ''), 'utf8');
}
if (opts['pr-body']) writeFileSync(opts['pr-body'], prBody(changes, sourceUrl, summary.skipped), 'utf8');
if (opts.summary) writeFileSync(opts.summary, JSON.stringify(summary, null, 2) + '\n', 'utf8');
if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${summary.changed}\npr_title=${summary.pr_title}\n`);
}
console.log(JSON.stringify(summary, null, 2));
