import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { SessionFileChange } from "./session-file-changes.ts";

export interface SessionDiffSection {
	title: string;
	diff?: string;
	message?: string;
}

/** Limit how much text Pi has to compare word by word. */
const MAX_DIFF_BYTES = 1024 * 1024;
const MAX_DIFF_LINES = 20_000;

function clean(text: string): string {
	return stripTerminalSequences(text)
		.replace(/\r\n?/g, "\n")
		.replace(/\p{Cc}/gu, (char) => (char === "\n" || char === "\t" ? char : ""));
}

/** Older results may only have a patch. Add line numbers for Pi's diff display. */
export function patchToDisplayDiff(patch: string): string {
	let oldLine = 0;
	let newLine = 0;
	let inHunk = false;
	const lines: string[] = [];
	for (const line of clean(patch).split("\n")) {
		if (line.startsWith("diff --git ")) inHunk = false;
		const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
		if (hunk) {
			oldLine = Number(hunk[1]);
			newLine = Number(hunk[2]);
			inHunk = true;
			if (lines.length) lines.push("     ...");
		} else if (inHunk && line.startsWith("-")) {
			lines.push(`-${oldLine++} ${line.slice(1)}`);
		} else if (inHunk && line.startsWith("+")) {
			lines.push(`+${newLine++} ${line.slice(1)}`);
		} else if (inHunk && line.startsWith(" ")) {
			lines.push(` ${newLine++} ${line.slice(1)}`);
			oldLine++;
		}
	}
	return lines.join("\n");
}

/** Show saved tool changes from this branch, not a diff against disk or Git. */
export function sessionDiffSections(change: SessionFileChange): SessionDiffSection[] {
	let bytesLeft = MAX_DIFF_BYTES;
	let linesLeft = MAX_DIFF_LINES;
	return change.edits.map((edit, index) => {
		const section: SessionDiffSection = { title: `${index + 1}/${change.edits.length} · ${edit.tool}` };
		const raw = edit.tool === "edit" ? (edit.diff ?? edit.patch) : edit.content;
		if (raw === undefined) {
			section.message = "No diff recorded for this operation.";
			return section;
		}
		const bytes = Buffer.byteLength(raw, "utf8");
		if (bytes > bytesLeft) {
			section.message = "Too large to preview (session diff limit: 1 MiB).";
			return section;
		}
		const lineCount = raw.split("\n").length;
		if (lineCount > linesLeft) {
			section.message = "Too many lines to preview (session diff limit: 20,000 lines).";
			return section;
		}
		bytesLeft -= bytes;
		linesLeft -= lineCount;
		if (raw.includes("\0")) {
			section.message = "Binary content is not previewed.";
			return section;
		}
		const text = clean(raw);
		if (edit.tool === "write") {
			section.message = "Written content only; previous contents were not recorded.";
			section.diff = text
				? text
						.replace(/\n$/, "")
						.split("\n")
						.map((line, i) => `+${i + 1} ${line}`)
						.join("\n")
				: "";
			if (!text) section.message += " Empty file.";
		} else {
			section.diff = edit.diff !== undefined ? text : patchToDisplayDiff(text);
			if (!section.diff) section.message = "No recorded changes to display.";
		}
		return section;
	});
}
