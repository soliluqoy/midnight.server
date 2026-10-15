import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

export interface SteeringDocument {
	path: string;
	name: string;
	text: string;
	hash: string;
}

export function steeringPathFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const raw = env.PI_CLM_STEERING?.trim();
	if (!raw || raw === "none" || raw === "off") return undefined;
	return raw;
}

export function loadSteeringDocument(path: string): SteeringDocument {
	const absolute = resolve(path);
	const raw = readFileSync(absolute);
	const text = raw.toString("utf8").trim();
	if (!text) throw new Error(`steering document is empty: ${absolute}`);
	return {
		path: absolute,
		name: basename(absolute),
		text,
		hash: createHash("sha256").update(raw).digest("hex").slice(0, 12),
	};
}

export function steeringPromptSection(doc: SteeringDocument): string {
	return `## Context-management guidance (${doc.name})\n\n${doc.text}`;
}

export function steeringStatusLine(doc: SteeringDocument | undefined): string {
	return doc ? `steering: ${doc.name} (sha256sum ${doc.hash}…) · ${doc.path}` : "steering: none (protocol only)";
}
