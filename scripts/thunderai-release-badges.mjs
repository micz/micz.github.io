#!/usr/bin/env node
// Writes the ThunderAI version badges served at https://micz.it/badges/thunderai/:
//   <dir>/release.svg     label "release",     color blue,   the latest stable tag
//   <dir>/prerelease.svg  label "pre-release", color orange, the pre-release tag to show
//   <dir>/dev.svg         label "dev",         color #BC2997 (magenta), the manifest.json version on ThunderAI's dev branch,
//                         shown with a leading "v" (5.3.0dev -> v5.3.0dev; a value already starting with v is kept)
// Used by .github/workflows/thunderai-release-badges.yml, by sparks-release-badges.yml and privacy-release-badges.yml for the
// ThunderAI Sparks and ThunderAI Privacy badges (same labels and colors, written with --dir static/badges/sparks or static/badges/privacy). Needs `npm ci` in scripts/ (badge-maker,
// the library of shields.io, pinned in package.json): the SVGs are made here, no badge service is
// called.
//
// Usage:
//   node scripts/thunderai-release-badges.mjs [--stable v3.7.0] [--prerelease v3.8.0pre1] [--dev 3.8.0dev] [--dir <path>]
//   node scripts/thunderai-release-badges.mjs --event "$GITHUB_EVENT_PATH" [--dir <path>]
//
// With --event the values are the fields stable / prerelease / dev of the client_payload of that
// repository_dispatch event file, and the options --stable / --prerelease / --dev are not allowed.
// An empty value writes an empty transparent SVG, so the badge disappears from the README.
// A missing option (or a field missing from the payload, e.g. a dispatch sent by an older ThunderAI
// workflow) leaves that file as it is. A value must be a string, empty or matching TAG_RE: anything
// else makes the script exit with an ::error:: annotation before writing anything.
// Prints "changed" / "unchanged" / "kept" for each file. When GITHUB_OUTPUT is set it also writes
// the outputs stable / prerelease / dev: the value, "hidden" (empty) or "unchanged" (missing).

import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { makeBadge } from "badge-maker";

const TAG_RE = /^v?[0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.]*$/;
const EMPTY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0"/>\n';
const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "static", "badges", "thunderai");

const badges = [
    { file: "release.svg", option: "stable", label: "release", color: "blue" },
    { file: "prerelease.svg", option: "prerelease", label: "pre-release", color: "orange" },
    // manifest.json has no "v" in its version: add it, like the tags of the other two badges.
    // #BC2997: white text contrast 5.4:1 (the named "yellow" was 1.9:1), distinct from blue and orange.
    { file: "dev.svg", option: "dev", label: "dev", color: "BC2997", prefixV: true },
];

const { values } = parseArgs({
    options: {
        stable: { type: "string" },
        prerelease: { type: "string" },
        dev: { type: "string" },
        event: { type: "string" },
        dir: { type: "string", default: DEFAULT_DIR },
    },
});

function fail(message) {
    console.log(`::error::${message}`);
    process.exit(1);
}

// source: where the values come from. A key that is not an own property = leave the file as it is.
let source = values;
if (values.event !== undefined) {
    if (badges.some((b) => values[b.option] !== undefined)) {
        fail(`--event cannot be used with --${badges.map((b) => b.option).join(" / --")}`);
    }
    let payload;
    try {
        payload = JSON.parse(readFileSync(values.event, "utf8")).client_payload;
    } catch (e) {
        fail(`Cannot read the event file ${JSON.stringify(values.event)}: ${e.message}`);
    }
    source = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
}

// Validate everything first: an invalid value must not leave one file written and another not.
let invalid = false;
for (const b of badges) {
    if (!Object.hasOwn(source, b.option) || source[b.option] === undefined) {
        b.tag = null; // missing: keep the file
        continue;
    }
    const tag = source[b.option];
    if (typeof tag !== "string" || (tag !== "" && !TAG_RE.test(tag))) {
        // JSON.stringify keeps newlines and control characters out of the annotation.
        console.log(`::error::Invalid ${b.option} value ${JSON.stringify(tag)}: it must be an empty string or match ${TAG_RE}`);
        invalid = true;
    }
    b.tag = b.prefixV && tag !== "" && !tag.startsWith("v") ? `v${tag}` : tag;
}
if (invalid) process.exit(1);

mkdirSync(values.dir, { recursive: true });
for (const b of badges) {
    b.summary = b.tag === null ? "unchanged" : b.tag || "hidden";
    if (b.tag === null) {
        console.log(`${b.file}: kept (missing ${b.option})`);
        continue;
    }
    const svg = b.tag === ""
        ? EMPTY_SVG
        : makeBadge({ label: b.label, message: b.tag, color: b.color, style: "flat" }) + "\n";
    const path = join(values.dir, b.file);
    let old = null;
    try {
        old = readFileSync(path, "utf8");
    } catch {
        // missing file: written below
    }
    if (old === svg) {
        console.log(`${b.file}: unchanged (${b.summary})`);
    } else {
        writeFileSync(path, svg);
        console.log(`${b.file}: changed (${b.summary})`);
    }
}

if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, badges.map((b) => `${b.option}=${b.summary}\n`).join(""));
}
