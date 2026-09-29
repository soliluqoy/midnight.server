#!/usr/bin/env node
// Prints the GitHub release notes for a midnight.server tag: the tag's section of
// packages/coding-agent/CHANGELOG.md followed by the install instructions.
// Usage: node scripts/midnight-release-notes.mjs v0.87.1-midnight.3
// Fails if the changelog has no `## [0.87.1-midnight.3]` section, so a release
// cannot be drafted before [Unreleased] was renamed to its version.

import { readFileSync } from "node:fs";

const tag = process.argv[2];
if (!tag || !/^v\d+\.\d+\.\d+-midnight\.\d+$/.test(tag)) {
	console.error("Usage: node scripts/midnight-release-notes.mjs v<pi-version>-midnight.<n>");
	process.exit(1);
}

const version = tag.slice(1);
const changelog = readFileSync(new URL("../packages/coding-agent/CHANGELOG.md", import.meta.url), "utf8");
const lines = changelog.split("\n");
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
if (start === -1) {
	console.error(`packages/coding-agent/CHANGELOG.md has no "## [${version}]" section.`);
	process.exit(1);
}
const end = lines.findIndex((line, i) => i > start && line.startsWith("## ["));
const section = lines
	.slice(start + 1, end === -1 ? undefined : end)
	.join("\n")
	.trim();
if (!section) {
	console.error(`The "## [${version}]" section is empty.`);
	process.exit(1);
}

console.log(`${section}

## Install

Windows (PowerShell):

\`\`\`powershell
irm https://raw.githubusercontent.com/soliluqoy/midnight.server/main/scripts/get.ps1 | iex
\`\`\`

Linux and macOS:

\`\`\`sh
curl -fsSL https://raw.githubusercontent.com/soliluqoy/midnight.server/main/scripts/get.sh | sh
\`\`\`

Or download an archive below and check it against \`SHA256SUMS\`.`);
