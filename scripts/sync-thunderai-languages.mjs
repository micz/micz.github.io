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
//   --contributors '<json>'      {"ko": [{ name, email, github, weblate, url, first, last, strings,
//                                lines }, ...]},
//                                overrides payload.contributors (old format ["Name", ...] | "Name, Name"
//                                still works)
//   --payload <file>             JSON file with { mode, locales, contributors?, ref, url }
//   --file <path>                languages.json to edit (default: the ThunderAI one in this repo)
//   --baseline <path>            languages.json to compare against for the PR text (default: the
//                                file as it was before this run)
//   --source-url <url>           link shown in the PR body (default: payload.url)
//   --summary <path>             also write the JSON summary to this file
//   --pr-body <path>             write the Markdown PR body to this file
//   --dry-run                    compute and print the summary, write nothing
//
// Contributors are the full list of every locale (in both modes), not a delta: the credits of
// every locale in the payload are checked against it, released or not, and the PR is where the
// changes get approved. `credits` is a list of items { name, url?, github?, weblate?, first?,
// hidden? } or { generated: true }; Hugo builds the text. Hand edits always win:
// - an item that matches a contributor (by GitHub login, then Weblate login, then profile link,
//   then name) is kept; the sync only adds the keys it does not have yet (a key set by hand, even
//   to null, stays), except "github": a login in the payload is always written;
// - GitHub always wins over Weblate: an item with "github" links https://github.com/<github>, and
//   "weblate" stays as data only;
// - a contributor matching no item gets a new item (null fields left out);
// - items matching no contributor are manual credits and stay;
// - "hidden": true keeps a person out of the page and stops the sync from adding them again;
// - { "generated": true } ("Generated automatically", never sent by ThunderAI) stays at the end.
// Credits follow the contribution order (strings, then lines, descending, then name): items of
// people in the payload first, then manual items in their order, then "Generated automatically".
// An entry with "keep_credits_order": true keeps its hand-made order and only gets new names
// appended. People merged in one locale (same email or GitHub login) add up strings and lines.
// Emails are used only as the key to merge duplicates and never reach the file, the PR or the output.
// The strings and lines of each person are listed in the PR body (and the summary), not in the file.
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

const clean = (value) => (typeof value === 'string' && value.trim()) ? value.trim() : null;

const EMAIL_RE = /<?[^\s<>@,]+@[^\s<>@,]+>?/g;

// Git names can be an email or hold one ("Kim <kim@x.org>"): drop it, and when nothing is left
// fall back to the GitHub login, then the Weblate one.
function nameWithoutEmail(item) {
    const name = clean(item.name)?.replace(EMAIL_RE, '').replace(/\(\s*\)|<\s*>/g, '').replace(/\s+/g, ' ').trim();
    return name || clean(item.github) || clean(item.weblate);
}

const date = (value) => /^\d{4}-\d{2}-\d{2}$/.test(clean(value) ?? '') ? value.trim() : null;

// strings / lines: a non-negative integer, or null when the payload has none (old format).
const count = (value) => Number.isInteger(value) && value >= 0 ? value : null;

// One contributor as { name, email, github, weblate, url, first, last, strings, lines }; a plain
// string is the old format.
function toContributor(item) {
    if (typeof item === 'string') item = { name: item };
    if (!item || typeof item !== 'object') return null;
    const name = nameWithoutEmail(item);
    if (!name) return null;
    const url = clean(item.url)?.includes('@') ? null : clean(item.url);
    // The Weblate login can come only as a profile link.
    const weblateLogin = url?.match(/^https?:\/\/hosted\.weblate\.org\/user\/([^/?#]+)\/?$/i)?.[1];
    return {
        name,
        email: clean(item.email)?.toLowerCase() ?? null,
        github: clean(item.github),
        weblate: clean(item.weblate) ?? (weblateLogin ? decodeURIComponent(weblateLogin) : null),
        url: url && /^https?:\/\//i.test(url) ? url : null,
        first: date(item.first),
        last: date(item.last),
        strings: count(item.strings),
        lines: count(item.lines),
    };
}

const minDate = (a, b) => (a && b) ? (a < b ? a : b) : (a ?? b);
const maxDate = (a, b) => (a && b) ? (a > b ? a : b) : (a ?? b);
const sum = (a, b) => (a == null && b == null) ? null : (a ?? 0) + (b ?? 0);

// Biggest contribution first: strings, then lines, descending, then name. People without
// numbers (old payload) keep the payload order among themselves.
function byContribution(a, b) {
    const d = (b.strings ?? 0) - (a.strings ?? 0) || (b.lines ?? 0) - (a.lines ?? 0);
    if (d) return d;
    const numbered = (p) => p.strings != null || p.lines != null;
    return numbered(a) && numbered(b) ? collator.compare(a.name, b.name) : 0;
}

// Contributors of one locale, merged by email, then by GitHub login; with neither, by name.
// Sorted by contribution.
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
        same.first = minDate(same.first, c.first);
        same.last = maxDate(same.last, c.last);
        same.strings = sum(same.strings, c.strings);
        same.lines = sum(same.lines, c.lines);
    }
    for (const p of people) if (p.github) p.url = githubUrl(p.github);
    return people.sort(byContribution);
}

// Merged contributors of a locale, or null when the payload has no list for it.
function contributorsFor(contributors, code) {
    if (!contributors) return null;
    const key = Object.keys(contributors).find((k) => normCode(k) === normCode(code));
    if (!key) return null;
    const value = contributors[key];
    return mergeContributors(Array.isArray(value) ? value : toList(value));
}

const githubUrl = (login) => `https://github.com/${login}`;

// "https://GitHub.com/Foo/" -> "github.com/foo"
const normUrl = (url) => url ? url.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '') : null;

function profileUrls(p) {
    return [p.url,
        p.github && githubUrl(p.github),
        p.weblate && `https://hosted.weblate.org/user/${p.weblate}/`].filter(Boolean).map(normUrl);
}

const sameName = (a, b) => collator.compare(a, b) === 0;
const sameLogin = (a, b) => !!(a && b) && a.toLowerCase() === b.toLowerCase();

// A credits item is this person when it has their GitHub or Weblate login, links one of their
// profiles or has their name.
const isItemOf = (item, p) => !item.generated && (sameLogin(item.github, p.github)
    || sameLogin(item.weblate, p.weblate)
    || (item.url && profileUrls(p).includes(normUrl(item.url)))
    || (item.name && sameName(item.name, p.name)));

// The item of a person, trying the keys in order: GitHub login, Weblate login, profile link, name.
// Items in the file have no email (the key that merged the payload), so these are what is left.
function findItem(credits, p) {
    const tests = [(i) => sameLogin(i.github, p.github), (i) => sameLogin(i.weblate, p.weblate),
        (i) => i.url && profileUrls(p).includes(normUrl(i.url)), (i) => i.name && sameName(i.name, p.name)];
    for (const test of tests) {
        const item = credits.find((i) => !i.generated && test(i));
        if (item) return item;
    }
    return null;
}

// New item of a person: no email, and no `last`, `strings` or `lines`, which would change on
// every commit (the order they give is the order of the list).
function newItem(p) {
    const item = { name: p.name };
    for (const k of ['url', 'github', 'weblate', 'first']) if (p[k]) item[k] = p[k];
    return item;
}

// Adds to an existing item the keys it does not have yet; `first` only moves earlier. The GitHub
// login of the payload always replaces the item's, and an item with a GitHub login links it.
function fillItem(item, p) {
    if (p.github) item.github = p.github;
    for (const k of ['url', 'weblate']) if (!(k in item) && p[k]) item[k] = p[k];
    if (item.github) item.url = githubUrl(item.github);
    if (p.first && (!('first' in item) || (item.first && p.first < item.first))) item.first = p.first;
}

// Brings entry.credits in line with the full contributor list of its locale (sorted by
// contribution). Returns the people added to the credits.
function syncCredits(entry, people) {
    const generated = entry.credits.filter((i) => i.generated);
    const credits = entry.credits.filter((i) => !i.generated);
    const added = [];
    for (const p of people) {
        const item = findItem(credits, p);
        if (item) { fillItem(item, p); continue; }
        credits.push(newItem(p));
        added.push(p);
    }
    if (entry.keep_credits_order !== true) {
        // Rank of an item: its person's place in the payload; manual items go after, in their order.
        const rank = new Map(credits.map((i) => {
            const at = people.findIndex((p) => isItemOf(i, p));
            return [i, at < 0 ? Infinity : at];
        }));
        credits.sort((a, b) => (rank.get(a) - rank.get(b)) || 0);
    }
    entry.credits = [...credits, ...generated];
    return added;
}

// Items and names shown on the page.
const shownItems = (credits) => (Array.isArray(credits) ? credits : []).filter((i) => !i.generated && !i.hidden);
const shownNames = (credits) => shownItems(credits).map((i) => i.name);

function checkEntries(entries, path) {
    if (!Array.isArray(entries) || entries.length === 0) fail(2, `${path} is not a non-empty array`);
    const last = entries[entries.length - 1];
    if (last.lang_code !== '') fail(2, `${path}: the last entry is not the sentinel (empty lang_code)`);
    const bad = entries.find((e) => e.lang_code && !Array.isArray(e.credits));
    if (bad) fail(2, `${path}: the credits of "${bad.lang_code}" are not a list`);
}

// Changes between two versions of the file, plus what a human must still fill in.
// Used for the PR, so that an update of the open PR lists everything it contains.
function describeChanges(before, after) {
    const old = new Map(before.filter((e) => e.lang_code).map((e) => [normCode(e.lang_code), e]));
    const added = [];
    const published = [];
    const credits = [];
    for (const e of after) {
        if (!e.lang_code) continue;
        const prev = old.get(normCode(e.lang_code));
        if (!prev) added.push(e);
        else if (!prev.released && e.released) published.push(e);
        if (prev && JSON.stringify(prev.credits) !== JSON.stringify(e.credits)) {
            const was = shownNames(prev.credits);
            const now = shownNames(e.credits);
            const urlOf = (list, name) => shownItems(list).find((i) => sameName(i.name, name))?.url;
            const added = now.filter((n) => !was.some((w) => sameName(w, n)));
            const kept = now.filter((n) => !added.includes(n));
            credits.push({ entry: e, added,
                removed: was.filter((w) => !now.some((n) => sameName(w, n))),
                linked: kept.filter((n) => urlOf(e.credits, n) && urlOf(e.credits, n) !== urlOf(prev.credits, n)),
                reordered: kept.join('\n') !== was.filter((w) => kept.some((n) => sameName(w, n))).join('\n') });
        }
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
        if (!shownNames(e.credits).length) {
            needsReview.push({ lang_code: e.lang_code, issue: 'credits',
                detail: `"${e.lang_name}": credits are empty${e.released ? ' (shown on the page, the language is released)' : ''}` });
        }
    }
    for (const c of credits) {
        const names = [...c.added, ...c.linked];
        if (names.length) {
            needsReview.push({ lang_code: c.entry.lang_code, issue: 'credits',
                detail: `"${c.entry.lang_name}": check the new names and links: ${names.join(', ')}${c.entry.released ? ' (shown on the page, the language is released)' : ''}` });
        }
    }
    return { added, published, credits, needsReview };
}

function prTitle(changes) {
    const parts = [];
    if (changes.published.length > 0 || changes.added.some((e) => e.released)) parts.push('publish languages');
    if (changes.added.some((e) => !e.released)) parts.push('new languages in progress');
    if (changes.credits.length > 0) parts.push('update credits');
    if (parts.length === 0) return 'ThunderAI: languages sync';
    return `ThunderAI: ${parts.slice(0, -1).join(', ')}${parts.length > 1 ? ' and ' : ''}${parts.at(-1)}`;
}

// Markdown table cell: no pipes or line breaks.
const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\s+/g, ' ');

function prBody(changes, sourceUrl, skipped, counts) {
    const lines = [];
    lines.push('Automatic update of `content/thunderbird-addon-thunderai/languages.json` from the ThunderAI repository.');
    if (sourceUrl) lines.push('', `Source: ${sourceUrl}`);
    lines.push('', '### Changes', '');
    for (const e of changes.added) {
        lines.push(`- Added \`${e.lang_code}\` ${e.lang_name} (${e.released ? 'released' : 'in progress'})`);
    }
    for (const e of changes.published) lines.push(`- Published \`${e.lang_code}\` ${e.lang_name}`);
    for (const c of changes.credits) {
        const what = [];
        if (c.added.length) what.push(`added ${c.added.join(', ')}`);
        if (c.removed.length) what.push(`removed ${c.removed.join(', ')}`);
        if (c.linked.length) what.push(`linked ${c.linked.join(', ')}`);
        if (c.reordered) what.push('reordered by contribution');
        if (!what.length) what.push('profiles or dates filled in');
        lines.push(`- Credits of \`${c.entry.lang_code}\` ${c.entry.lang_name}: ${what.join('; ')}`);
    }
    if (skipped.length) {
        lines.push('', '<details><summary>Skipped in the last event</summary>', '');
        for (const s of skipped) lines.push(`- \`${s.code}\`: ${s.reason}`);
        lines.push('', '</details>');
    }
    if (counts.length) {
        lines.push('', '### Contributions in the last event', '',
            'The numbers that order the credits (strings, then lines). They are not saved in the file.');
        for (const c of counts) {
            lines.push('', `<details><summary><code>${c.lang_code}</code> ${c.lang_name}${c.keep_order ? ' (order kept by hand)' : ''}</summary>`, '',
                '| # | Name | Strings | Lines |', '|---:|---|---:|---:|');
            c.people.forEach((p, i) => lines.push(`| ${i + 1} | ${cell(p.name)} | ${p.strings ?? '–'} | ${p.lines ?? '–'} |`));
            lines.push('', '</details>');
        }
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

const summary = { mode, file, dry_run: opts.dryRun, changed: false, added: [], published: [], credits: [], counts: [], skipped: [], needs_review: [] };
const seen = new Set();

for (const code of locales) {
    if (!CODE_RE.test(code)) { summary.skipped.push({ code, reason: 'invalid code' }); continue; }
    if (seen.has(normCode(code))) { summary.skipped.push({ code, reason: 'duplicate in input' }); continue; }
    seen.add(normCode(code));

    let entry = entries.find((e) => e.lang_code && normCode(e.lang_code) === normCode(code));
    if (entry) {
        if (mode === 'release' && !entry.released) {
            entry.released = true;
            summary.published.push({ lang_code: entry.lang_code, lang_name: entry.lang_name });
        }
    } else {
        const name = buildName(code);
        if (!name) { summary.skipped.push({ code, reason: `no display name for ${toBcp47(code)}` }); continue; }
        entry = { lang_name: name.lang_name, lang_code: code, released: mode === 'release', credits: [] };
        const { index, placement } = insertIndex(entries, name.native);
        entries.splice(index, 0, entry);
        summary.added.push({ lang_name: entry.lang_name, lang_code: code, released: entry.released, placement,
            after: index > 0 ? entries[index - 1].lang_code : null });
        if (hasNonLatinLetters(name.native)) {
            summary.needs_review.push({ lang_code: code, issue: 'romanization',
                detail: `native name "${name.native}" has no romanization; entry placed before the sentinel` });
        }
    }

    // Credits of every locale in the payload, already present or not.
    const people = contributorsFor(contributors, code);
    if (people) {
        const before = JSON.stringify(entry.credits);
        const added = syncCredits(entry, people);
        // Hidden people stay out of the PR as well.
        summary.counts.push({ lang_code: entry.lang_code, lang_name: entry.lang_name, keep_order: entry.keep_credits_order === true,
            people: people.filter((p) => !findItem(entry.credits, p)?.hidden)
                .map((p) => ({ name: p.name, strings: p.strings, lines: p.lines })) });
        if (JSON.stringify(entry.credits) !== before) {
            summary.credits.push({ lang_code: entry.lang_code, shown: shownNames(entry.credits),
                added: added.map((p) => ({ name: p.name, url: p.url, first: p.first, last: p.last, strings: p.strings, lines: p.lines })) });
        }
    }
    const isNew = [...summary.added, ...summary.published].some((a) => a.lang_code === entry.lang_code);
    if (!shownNames(entry.credits).length && isNew) {
        summary.needs_review.push({ lang_code: entry.lang_code, issue: 'credits', detail: 'credits are empty' });
    }
}

summary.changed = JSON.stringify(entries) !== JSON.stringify(original);

const baseline = opts.baseline ? readJson(opts.baseline, 'baseline') : original;
const changes = describeChanges(baseline, entries);
summary.pr_title = prTitle(changes);

if (summary.changed && !opts.dryRun) {
    writeFileSync(file, JSON.stringify(entries, null, 4).replace(/\n/g, eol) + (finalNewline ? eol : ''), 'utf8');
}
if (opts['pr-body']) writeFileSync(opts['pr-body'], prBody(changes, sourceUrl, summary.skipped, summary.counts.filter((c) => c.people.length)), 'utf8');
if (opts.summary) writeFileSync(opts.summary, JSON.stringify(summary, null, 2) + '\n', 'utf8');
if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${summary.changed}\npr_title=${summary.pr_title}\n`);
}
console.log(JSON.stringify(summary, null, 2));
