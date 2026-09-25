import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import { join } from "node:path";
import { APP_NAME, VERSION } from "../config.ts";
import { getPowerShellConfig } from "../utils/shell.ts";
import {
	type BackendMeasurement,
	clearBackendChoice,
	newChoice,
	userGpuLayers,
	writeBackendChoice,
} from "./backend.ts";
import type { DownloadProgress } from "./download.ts";
import { resolveEngineSettings } from "./engine.ts";
import { describeChoice, EngineManager, previewSelection, probe, resolveModel } from "./engine-manager.ts";
import {
	createHelperTask,
	formatHelperResult,
	GIT_OPS,
	type GitOp,
	HELPER_KINDS,
	type HelperGitRequest,
	type HelperKind,
	runHelperTask,
} from "./helper.ts";
import { engineDirCandidates, getInstallDir, getMidnightHome, hostCandidates, modelCandidates } from "./paths.ts";
import {
	availableBackends,
	cpuBackend,
	currentEnginePlatform,
	type EngineBackend,
	engineDownloadBytes,
	engineLock,
	MODEL_LOCK,
	modelDownloadUrl,
	parseBackend,
} from "./pins.ts";
import {
	ensureModelVerified,
	fetchEngine,
	fetchModel,
	findEngineDir,
	findHost,
	findModel,
	installedEngineDir,
} from "./store.ts";

export const MIDNIGHT_COMMANDS = ["model", "engine", "doctor", "helper"] as const;

const GiB = 1024 ** 3;

function progressPrinter(label: string): (progress: DownloadProgress) => void {
	let lastPercent = -1;
	return ({ receivedBytes, totalBytes }) => {
		const percent = Math.floor((receivedBytes / totalBytes) * 100);
		if (percent === lastPercent) return;
		lastPercent = percent;
		const [unit, size] = totalBytes >= GiB ? ["GiB", GiB] : ["MiB", 1024 ** 2];
		process.stderr.write(
			`\r${label}: ${percent}% (${(receivedBytes / size).toFixed(2)} / ${(totalBytes / size).toFixed(2)} ${unit})`,
		);
		if (receivedBytes === totalBytes) process.stderr.write("\n");
	};
}

function interruptSignal(): AbortSignal {
	const controller = new AbortController();
	process.once("SIGINT", () => controller.abort());
	return controller.signal;
}

async function modelCommand(args: string[]): Promise<number> {
	const sub = args[0] ?? "status";
	const signal = interruptSignal();
	if (sub === "status") {
		const path = findModel();
		console.log(`Model:    ${MODEL_LOCK.modelId} (${MODEL_LOCK.fileName})`);
		console.log(`Revision: ${MODEL_LOCK.repository}@${MODEL_LOCK.revision}`);
		console.log(`SHA-256:  ${MODEL_LOCK.sha256}`);
		console.log(`Location: ${path ?? "not installed"}`);
		if (!path) console.log(`Searched: ${modelCandidates(MODEL_LOCK.fileName).join(", ")}`);
		return path ? 0 : 1;
	}
	if (sub === "verify") {
		const path = findModel();
		if (!path) {
			console.error(`Model not installed. Run: ${APP_NAME} model fetch`);
			return 1;
		}
		console.error(`Hashing ${path}...`);
		await ensureModelVerified(path, MODEL_LOCK, { force: true, signal });
		console.log(`Verified ${path}`);
		return 0;
	}
	if (sub === "fetch") {
		const existing = findModel();
		if (existing) {
			await ensureModelVerified(existing, MODEL_LOCK, { signal });
			console.log(`Already installed and verified: ${existing}`);
			return 0;
		}
		console.error(`Downloading ${modelDownloadUrl(MODEL_LOCK)}`);
		const path = await fetchModel(MODEL_LOCK, { signal, onProgress: progressPrinter("Model") });
		console.log(`Installed and verified: ${path}`);
		return 0;
	}
	console.error(`Usage: ${APP_NAME} model [status|verify|fetch]`);
	return 2;
}

function formatMeasurement(measurement: BackendMeasurement): string {
	const where = measurement.gpuLayers > 0 ? "GPU" : "CPU";
	return `${`${measurement.backend} on ${where}`.padEnd(16)} prompt ${measurement.promptTokensPerSecond.toFixed(1)} tok/s, generation ${measurement.generationTokensPerSecond.toFixed(1)} tok/s, ~${Math.round(measurement.estimatedSeconds)} s per typical task`;
}

function backendArgument(name: string | undefined): EngineBackend {
	const backend = name ? parseBackend(name.toLowerCase()) : undefined;
	if (!backend) {
		throw new Error(
			`${name ? `Unknown backend "${name}" for ${process.platform}-${process.arch}. ` : ""}Available: ${availableBackends().join(", ") || "none"}`,
		);
	}
	return backend;
}

async function engineCommand(args: string[]): Promise<number> {
	const sub = args[0] ?? "status";
	const platform = currentEnginePlatform();
	if (sub === "status") {
		const selection = await previewSelection();
		const cpuLock = engineLock(cpuBackend());
		const release = selection.lock ?? cpuLock;
		console.log(
			release
				? `Engine:   ${release.name} ${release.release} (${release.commit.slice(0, 12)}) for ${release.platform}`
				: `Engine:   no pinned builds for ${process.platform}-${process.arch}`,
		);
		console.log(`Backend:  ${selection.label}`);
		const dir = findEngineDir(selection.lock);
		console.log(`Location: ${dir ?? "not installed (downloads on first use)"}`);
		const host = findHost();
		if (process.platform === "win32")
			console.log(`Host:     ${host ?? `not found; searched ${hostCandidates().join(", ")}`}`);
		console.log("\nBuilds for this platform:");
		for (const backend of availableBackends(platform)) {
			const lock = engineLock(backend, platform);
			if (!lock) continue;
			const installed = engineDirCandidates(lock)
				.map((root) => installedEngineDir(root, lock))
				.find(Boolean);
			console.log(
				`  ${backend.padEnd(10)} ${installed ? `installed  ${installed}` : `${Math.round(engineDownloadBytes(lock) / 1024 ** 2)} MiB download`}`,
			);
		}
		console.log(
			`\nChange with: ${APP_NAME} engine use <backend|auto>, or measure again with: ${APP_NAME} engine probe`,
		);
		return dir && (host || process.platform !== "win32") ? 0 : 1;
	}
	if (sub === "fetch") {
		const backend = args[1] ? backendArgument(args[1]) : ((await previewSelection()).lock?.backend ?? cpuBackend());
		const lock = engineLock(backend);
		if (!lock) throw new Error(`No pinned ${backend} engine for ${process.platform}-${process.arch}`);
		console.error(`Downloading the ${backend} engine (${Math.round(engineDownloadBytes(lock) / 1024 ** 2)} MiB)`);
		const dir = await fetchEngine(lock, { signal: interruptSignal(), onProgress: progressPrinter("Engine") });
		console.log(`Engine installed: ${dir}`);
		return 0;
	}
	if (sub === "use") {
		if (args[1]?.toLowerCase() === "auto") {
			await clearBackendChoice();
			console.log("Backend: auto. GPU and CPU are measured on the next engine start.");
			return 0;
		}
		const backend = backendArgument(args[1]);
		const lock = engineLock(backend);
		if (!lock) throw new Error(`No pinned ${backend} engine for ${process.platform}-${process.arch}`);
		await writeBackendChoice(newChoice(lock, userGpuLayers(backend), "user", "set with engine use"));
		console.log(
			`Backend: ${backend}${userGpuLayers(backend) > 0 ? " with every layer on the GPU" : ""}. It downloads on the next engine start if needed.`,
		);
		return 0;
	}
	if (sub === "probe") {
		const signal = interruptSignal();
		const onStatus = (message: string) => console.error(message);
		const model = await resolveModel(signal, onStatus);
		const result = await probe({ model, signal, onStatus });
		console.log("");
		for (const measurement of result.choice.measurements ?? []) console.log(formatMeasurement(measurement));
		console.log(`Selected: ${describeChoice(result.choice)}`);
		if (result.persist) await writeBackendChoice(result.choice);
		else console.log("Not saved: the result reflects a temporary problem. Run the probe again later.");
		return 0;
	}
	console.error(`Usage: ${APP_NAME} engine [status | fetch [backend] | use <backend|auto> | probe]`);
	return 2;
}

function check(ok: boolean, label: string, detail: string): boolean {
	console.log(`${ok ? "ok  " : "FAIL"}  ${label}: ${detail}`);
	return ok;
}

/** Environment and installation diagnostics. Does not load the model unless --smoke is passed. */
async function doctorCommand(args: string[]): Promise<number> {
	let ok = true;
	console.log(
		`${APP_NAME} ${VERSION} (${process.platform}-${process.arch}, ${process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`})`,
	);
	console.log(`Install dir: ${getInstallDir()}`);
	console.log(`State dir:   ${getMidnightHome()}`);
	const selection = await previewSelection();
	const settings = resolveEngineSettings({}, selection.gpuLayers);
	console.log(`Backend:     ${selection.label}`);
	console.log(
		`Engine settings: context ${settings.contextSize}, threads ${settings.threads}, GPU layers ${settings.gpuLayers}`,
	);
	console.log("");
	const total = totalmem() / GiB;
	ok =
		check(
			total >= 7.5,
			"memory",
			`${total.toFixed(1)} GiB total, ${(freemem() / GiB).toFixed(1)} GiB free (16 GiB recommended)`,
		) && ok;
	const model = findModel();
	ok = check(Boolean(model), "model", model ?? `missing; run ${APP_NAME} model fetch`) && ok;
	const engine = findEngineDir(selection.lock);
	// A pinned build that is not installed yet downloads on first start; only a platform without one is a failure.
	ok =
		check(
			Boolean(engine || selection.lock),
			`engine (${selection.lock?.backend ?? "custom"})`,
			engine ??
				(selection.lock
					? `not installed yet; downloads on first start (or run ${APP_NAME} engine fetch)`
					: `no pinned build for ${process.platform}-${process.arch}; set MIDNIGHT_SERVER_ENGINE_DIR`),
		) && ok;
	if (process.platform === "win32") {
		const host = findHost();
		ok = check(Boolean(host), "process host", host ?? "midnight-host.exe missing") && ok;
		if (host) {
			const version = spawnSync(host, ["--version"], { encoding: "utf8", windowsHide: true, input: "" });
			ok = check(version.status === 0, "process host runs", version.stdout.trim() || version.stderr.trim()) && ok;
		}
		try {
			const shell = getPowerShellConfig().shell;
			check(true, "PowerShell", shell);
		} catch (error) {
			ok = check(false, "PowerShell", error instanceof Error ? error.message : String(error)) && ok;
		}
		const git = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "cmd", "git.exe");
		check(true, "git", existsSync(git) ? git : "not found (optional; needed for repository features)");
	}

	if (args.includes("--smoke") && ok) {
		const manager = new EngineManager({ idleMs: 0, onStatus: (message) => console.log(message) });
		try {
			const started = Date.now();
			const engine = await manager.get(interruptSignal());
			check(true, "engine start", `${Date.now() - started} ms at ${engine.baseUrl}`);
			const reply = await engine.chat({
				messages: [{ role: "user", content: "Reply with the single word: ready" }],
				maxTokens: 64,
				enableThinking: false,
			});
			ok =
				check(
					reply.content.trim().length > 0,
					"generation",
					`${JSON.stringify(reply.content.trim().slice(0, 40))} (${reply.completionTokens} tokens in ${Math.round(reply.predictedMs ?? 0)} ms)`,
				) && ok;
		} catch (error) {
			ok = check(false, "engine start", error instanceof Error ? error.message : String(error)) && ok;
		} finally {
			await manager.stop();
		}
	} else if (!args.includes("--smoke")) {
		console.log(`\nRun "${APP_NAME} doctor --smoke" to start the engine and generate a test reply.`);
	}
	return ok ? 0 : 1;
}

function parseHelperArgs(args: string[]): {
	kind: HelperKind;
	instruction: string;
	paths: string[];
	context?: string;
	git?: HelperGitRequest;
	json: boolean;
} {
	const [kind, ...rest] = args;
	if (!kind || !(HELPER_KINDS as readonly string[]).includes(kind)) {
		throw new Error(
			`Usage: ${APP_NAME} helper <${HELPER_KINDS.join("|")}> "<instruction>" [file ...] [--context <text>] ` +
				`[--git-op ${GIT_OPS.join("|")}] [--git-ref <ref>] [--git-staged] [--git-max-count <n>] [--json]`,
		);
	}
	const paths: string[] = [];
	let instruction: string | undefined;
	let context: string | undefined;
	let json = false;
	let gitOp: GitOp | undefined;
	let gitRef: string | undefined;
	let gitStaged = false;
	let gitMaxCount: number | undefined;
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "--context") context = rest[++i];
		else if (arg === "--json") json = true;
		else if (arg === "--git-op") {
			const value = rest[++i];
			if (!value || !(GIT_OPS as readonly string[]).includes(value)) {
				throw new Error(`--git-op must be one of: ${GIT_OPS.join("|")}`);
			}
			gitOp = value as GitOp;
		} else if (arg === "--git-ref") gitRef = rest[++i];
		else if (arg === "--git-staged") gitStaged = true;
		else if (arg === "--git-max-count") gitMaxCount = Number(rest[++i]);
		else if (instruction === undefined) instruction = arg;
		else paths.push(arg);
	}
	if (!instruction) throw new Error("A helper instruction is required.");
	const git: HelperGitRequest | undefined = gitOp
		? { op: gitOp, ref: gitRef, staged: gitStaged || undefined, maxCount: gitMaxCount }
		: undefined;
	return { kind: kind as HelperKind, instruction, paths, context, git, json };
}

/** Explicit assignment: run one helper task directly, with no cloud provider involved. */
async function helperCommand(args: string[]): Promise<number> {
	const parsed = parseHelperArgs(args);
	const manager = new EngineManager({ idleMs: 0, onStatus: (message) => process.stderr.write(`${message}\n`) });
	const signal = interruptSignal();
	try {
		const engine = await manager.get(signal);
		process.stderr.write(`Running ${parsed.kind} task...\n`);
		const result = await runHelperTask(
			engine,
			createHelperTask({
				kind: parsed.kind,
				instruction: parsed.instruction,
				workspaceRoot: process.cwd(),
				paths: parsed.paths,
				context: parsed.context,
				git: parsed.git,
			}),
			{ signal, artifactDir: join(getMidnightHome(), "artifacts") },
		);
		console.log(parsed.json ? JSON.stringify(result, null, 2) : formatHelperResult(result));
		return result.status === "completed" ? 0 : 1;
	} finally {
		await manager.stop();
	}
}

/** Returns an exit code if `args` is a midnight.server subcommand, otherwise undefined. */
export async function runMidnightCommand(args: string[]): Promise<number | undefined> {
	const handlers: Record<(typeof MIDNIGHT_COMMANDS)[number], (rest: string[]) => Promise<number>> = {
		model: modelCommand,
		engine: engineCommand,
		doctor: doctorCommand,
		helper: helperCommand,
	};
	const name = args[0];
	if (!name || !Object.hasOwn(handlers, name)) return undefined;
	const handler = handlers[name as (typeof MIDNIGHT_COMMANDS)[number]];
	try {
		return await handler(args.slice(1));
	} catch (error) {
		console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}
