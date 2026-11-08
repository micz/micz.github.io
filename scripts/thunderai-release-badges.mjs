#!/usr/bin/env node
// Writes the ThunderAI version badges served at https://micz.it/badges/thunderai/:
//   <dir>/release.svg     label "release",     color blue,   the latest stable tag
//   <dir>/prerelease.svg  label "pre-release", color orange, the pre-release tag to show
// Used by .github/workflows/thunderai-release-badges.yml. Needs `npm ci` in scripts/ (badge-maker,
// the library of shields.io, pinned in package.json): the SVGs are made here, no badge service is
// called.
//
// Usage:
//   node scripts/thunderai-release-badges.mjs --stable v3.7.0 --prerelease v3.8.0pre1 [--dir <path>]
//
// An empty tag (or a missing option) writes an empty transparent SVG, so the badge disappears from
// the README. A tag must be empty or match TAG_RE: any other value makes the script exit with an
// ::error:: annotation before writing anything. Prints "changed" / "unchanged" for each file.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { makeBadge } from "badge-maker";

const TAG_RE = /^v?[0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.]*$/;
const EMPTY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0"/>\n';
const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "static", "badges", "thunderai");

const { values } = parseArgs({
    options: {
        stable: { type: "string", default: "" },
        prerelease: { type: "string", default: "" },
        dir: { type: "string", default: DEFAULT_DIR },
    },
});

const badges = [
    { file: "release.svg", option: "stable", label: "release", color: "blue" },
    { file: "prerelease.svg", option: "prerelease", label: "pre-release", color: "orange" },
];

// Validate everything first: an invalid tag must not leave one file written and the other not.
let invalid = false;
for (const b of badges) {
    const tag = values[b.option];
    if (tag !== "" && !TAG_RE.test(tag)) {
        // JSON.stringify keeps newlines and control characters out of the annotation.
        console.log(`::error::Invalid ${b.option} tag ${JSON.stringify(tag)}: it must be empty or match ${TAG_RE}`);
        invalid = true;
    }
    b.tag = tag;
}
if (invalid) process.exit(1);

mkdirSync(values.dir, { recursive: true });
for (const b of badges) {
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
        console.log(`${b.file}: unchanged (${b.tag || "hidden"})`);
    } else {
        writeFileSync(path, svg);
        console.log(`${b.file}: changed (${b.tag || "hidden"})`);
    }
}
