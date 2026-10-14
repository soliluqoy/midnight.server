import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	addUsage,
	type CallResult,
	type Classification,
	emptyUsage,
	ScaleDownClient,
	type Summary,
} from "../src/scaledown/client.ts";
import { prepareLog, redact } from "../src/scaledown/log.ts";

// Explicit live integration test, deliberately excluded from the offline test suite.
// Uses real npm output, not fabricated errors. Never retries paid API requests.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const supportedPiVersion: string = manifest.peerDependencies["@earendil-works/pi-coding-agent"];
assert.match(supportedPiVersion, /^\d+\.\d+\.\d+$/, "The smoke test requires an exact Pi version pin.");
assert.equal(manifest.peerDependencies["@earendil-works/pi-tui"], supportedPiVersion, "Pi peer pins must match.");
// Deliberately unsupported fixture, never the supported installation target.
const unsupportedPiVersion = "1.0.4";
assert.notEqual(supportedPiVersion, unsupportedPiVersion, "Choose an unsupported peer-conflict fixture.");
const key = process.env.SCALEDOWN_API_KEY?.trim();
assert.equal(process.env.SCALEDOWN_ENABLED, "1", "Live uploads require explicit SCALEDOWN_ENABLED=1 consent.");
assert.ok(key, "Set SCALEDOWN_API_KEY securely before running; never paste it into chat.");
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run this script with npm run test:scaledown:live.");
const npmExecutable: string = npmCli;
const timeoutMs = Number(process.env.SCALEDOWN_TIMEOUT_MS ?? 15000);
assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 60000, "Invalid SCALEDOWN_TIMEOUT_MS.");
const requestLimit = Number(process.env.SCALEDOWN_MAX_REQUESTS ?? 20);
assert.ok(
	Number.isInteger(requestLimit) && requestLimit >= 4 && requestLimit <= 1000,
	"This smoke test needs four requests; SCALEDOWN_MAX_REQUESTS must be 4–1000.",
);
await mkdir(join(root, ".artifacts"), { recursive: true });
const directory = await mkdtemp(join(root, ".artifacts", "scaledown-smoke-"));
console.log(`Artifacts: ${directory}\nLive ScaleDown requests: four (two per log); reported costs may be incomplete.`);

async function npm(args: string[], cwd: string, name: string) {
	const result = spawnSync(process.execPath, [npmExecutable, ...args], {
		cwd,
		encoding: "utf8",
		timeout: 120000,
		maxBuffer: 1024 * 1024,
		// Command logs never need the provider credential or persistent upload consent.
		env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("SCALEDOWN_"))),
	});
	const path = join(directory, `${name}.log`);
	await writeFile(path, `${result.stdout ?? ""}${result.stderr ?? ""}`);
	assert.ok(!result.error, `npm failed to execute; inspect ${path}`);
	assert.equal(result.signal, null, `npm was terminated; inspect ${path}`);
	assert.notEqual(result.status, null, `npm did not report an exit code; inspect ${path}`);
	console.log(`${name}: exit ${result.status}`);
	return { path, exitCode: result.status, stdout: result.stdout };
}

const passing = await npm(["test"], root, "passing-tests");
assert.equal(passing.exitCode, 0, `Project tests failed; inspect ${passing.path}`);
const pack = await npm(["pack", "--pack-destination", directory], root, "pack");
assert.equal(pack.exitCode, 0, `Package creation failed; inspect ${pack.path}`);
const tarball = join(directory, pack.stdout.trim().split(/\r?\n/).at(-1) ?? "");
assert.ok(tarball.endsWith(".tgz"), "npm pack did not report a tarball.");
const consumer = join(directory, "consumer");
await mkdir(consumer);
async function consumerManifest(version: string) {
	await writeFile(
		join(consumer, "package.json"),
		JSON.stringify(
			{
				name: "midnight-scaledown-consumer-smoke",
				version: "1.0.0",
				private: true,
				dependencies: {
					"midnight.server": `file:${tarball.replaceAll("\\", "/")}`,
					"@earendil-works/pi-coding-agent": version,
					"@earendil-works/pi-tui": version,
					typebox: "*",
				},
			},
			null,
			2,
		),
	);
}
const installArgs = ["install", "--dry-run", "--ignore-scripts", "--no-audit", "--no-fund"];
await consumerManifest(unsupportedPiVersion);
const failing = await npm(installArgs, consumer, "peer-conflict");
assert.notEqual(failing.exitCode, 0, `Expected the pinned peer dependency to reject Pi ${unsupportedPiVersion}.`);
await consumerManifest(supportedPiVersion);
const compatible = await npm(installArgs, consumer, "compatible-install");
assert.equal(compatible.exitCode, 0, `Supported Pi ${supportedPiVersion} did not resolve; inspect ${compatible.path}`);

const client = new ScaleDownClient();
const signal = AbortSignal.timeout(2 * timeoutMs + 5000);
const usage = emptyUsage();
const results = [];
for (const [command, expected] of [
	[passing, "other"],
	[failing, "dependency"],
] as const) {
	const log = await prepareLog(root, { path: command.path, startLine: 1, maxLines: 400 }, key, signal);
	if (expected === "dependency") assert.match(log.text, /ERESOLVE/, "Failure must be a real peer-resolution error.");
	const [classification, summary]: [CallResult<Classification>, CallResult<Summary>] = await Promise.all([
		client.classify(log.text, key, signal, timeoutMs),
		client.summarize(log.text, key, signal, timeoutMs),
	]);
	for (const result of [classification, summary]) addUsage(usage, result.usage);
	const result = {
		source: log.source,
		snapshot: log.snapshot,
		sha256: log.sha256,
		exitCode: command.exitCode,
		startLine: log.startLine,
		endLine: log.endLine,
		totalLines: log.totalLines,
		expected,
		classification,
		summary: summary.value
			? { ...summary, value: { ...summary.value, text: redact(summary.value.text, key) } }
			: summary,
		evidence: log.evidence,
	};
	results.push(result);
	// Save even a failed/partial provider response before asserting.
	await writeFile(
		join(directory, "report.json"),
		JSON.stringify({ requests: results.length * 2, usage, results }, null, 2),
	);
	assert.ok(classification.value, classification.error ?? "Missing classification.");
	assert.ok(summary.value, summary.error ?? "Missing summary.");
	assert.equal(classification.value.category, expected, `Wrong category; inspect ${join(directory, "report.json")}`);
	assert.equal(summary.value.truncated, false, "Summary was truncated.");
	if (expected === "dependency") {
		assert.match(summary.value.text, /ERESOLVE/);
		assert.ok(summary.value.text.includes(supportedPiVersion), "Summary must preserve the supported Pi version.");
		assert.ok(summary.value.text.includes(unsupportedPiVersion), "Summary must preserve the conflicting Pi version.");
	}
	console.log(`\n${expected}: ${(classification.value.confidence * 100).toFixed(1)}%\n${result.summary.value?.text}`);
}
console.log(
	`\nPASS: real passing tests + real peer conflict triaged; supported install resolves.\nReport: ${join(directory, "report.json")}\nReported tokens: ${usage.totalTokens}; reported cost: $${usage.cost.total.toFixed(6)} (may be incomplete).`,
);
