#!/usr/bin/env node
/**
 * Recount harness messages in results written before scripts/harness-eval.mjs counted appended
 * entries (settle-time and in-run messages arrive as `entry_appended`, not `message_end`).
 * Reads each run's saved event stream and rewrites harnessChecks, driftNudges,
 * contractReminders and advice. Writes <results>.recounted.jsonl next to the input.
 *
 * Usage: node evals/drift/recount.mjs <results.jsonl>
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const COUNTERS = {
	harness_check: "harnessChecks",
	harness_drift: "driftNudges",
	harness_contract: "contractReminders",
	harness_advice: "advice",
};

const input = process.argv[2];
if (!input) {
	console.error("Usage: node evals/drift/recount.mjs <results.jsonl>");
	process.exit(1);
}
const out = [];
for (const line of readFileSync(input, "utf8").split("\n").filter(Boolean)) {
	const record = JSON.parse(line);
	if (record.events && existsSync(record.events)) {
		for (const field of Object.values(COUNTERS)) record[field] = 0;
		for (const eventLine of readFileSync(record.events, "utf8").split("\n")) {
			if (!eventLine.includes("harness_")) continue;
			let event;
			try {
				event = JSON.parse(eventLine);
			} catch {
				continue;
			}
			const type =
				event.type === "entry_appended" && event.entry?.type === "custom_message"
					? event.entry.customType
					: event.type === "message_end" && event.message?.role === "custom"
						? event.message.customType
						: undefined;
			if (type && COUNTERS[type]) record[COUNTERS[type]]++;
		}
	}
	out.push(JSON.stringify(record));
}
const target = input.replace(/\.jsonl$/, ".recounted.jsonl");
writeFileSync(target, `${out.join("\n")}\n`);
console.log(`Wrote ${target} (${out.length} runs)`);
