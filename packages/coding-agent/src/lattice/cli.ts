#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonical } from "./canonical.ts";
import type { Type, Value } from "./ir.ts";
import { defaultDataDir, Lattice, selftest } from "./kernel.ts";
import { POLICY_SKILL } from "./metapolicy.ts";
import { clampPolicy, type SearchPolicy } from "./search.ts";
import { serve } from "./server.ts";

/**
 * `lattice` command line (spec section 17.1). Every command prints one JSON document on stdout;
 * errors go to stderr with exit code 1. Local only: no command opens a network connection.
 */
const USAGE = `lattice [--data DIR] [--no-adapter] <command>

  init                                   create the store, seeds, capability key, seed snapshot
  status                                 active versions, integrity, budgets
  selftest                               end-to-end self-test in a temporary store
  goal "TEXT"                            goal from text via the template adapter
  goal --contract ID (--dir PATH | --input FILE) [--max-ms N]
  run skill ID --input FILE              run any installed skill on a JSON input
  inspect skill ID                       active program and version metadata
  explain skill ID | explain episode ID  evidence behind a version or an episode
  improve skill ID [--policy reference] [--gated] [--no-isolate] [--seed N] [--no-shadow]
  improve policy [--proposals N] [--budget N] [--tasks N]
  test skill ID                          diagnostic run; re-enables promotion when it passes
  rollback skill ID [--to-version N]
  compile skill ID                       bytecode with differential test
  mine [--keep N]                        library learning over accepted programs
  synthesize --examples FILE [--install] program synthesis from examples
  snapshot create | snapshot list | snapshot verify ID
  policy show | policy check
  audit [--subject S] [--limit N] | audit verify
  recover                                corruption recovery of active versions
  maintenance                            garbage collection, WAL checkpoint, integrity
  serve [--path PIPE]                    local API on a named pipe / Unix socket`;

interface Args {
	positional: string[];
	flags: Map<string, string | true>;
}

function parse(argv: readonly string[]): Args {
	const positional: string[] = [];
	const flags = new Map<string, string | true>();
	const valued = new Set([
		"data",
		"contract",
		"dir",
		"input",
		"max-ms",
		"policy",
		"seed",
		"proposals",
		"budget",
		"tasks",
		"to-version",
		"keep",
		"examples",
		"subject",
		"limit",
		"path",
	]);
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg.startsWith("--")) {
			const name = arg.slice(2);
			if (valued.has(name)) {
				if (i + 1 >= argv.length) throw new Error(`--${name} needs a value`);
				flags.set(name, argv[++i]);
			} else flags.set(name, true);
		} else positional.push(arg);
	}
	return { positional, flags };
}

function readJsonFile(path: string): unknown {
	const full = resolve(path);
	if (statSync(full).size > 4 * 1024 * 1024) throw new Error("input exceeds 4 MiB");
	return JSON.parse(readFileSync(full, "utf8")) as unknown;
}

function int(args: Args, name: string): number | undefined {
	const value = args.flags.get(name);
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) throw new Error(`--${name} must be an integer`);
	return parsed;
}

function str(args: Args, name: string): string | undefined {
	const value = args.flags.get(name);
	return typeof value === "string" ? value : undefined;
}

function need(value: string | undefined, what: string): string {
	if (!value) throw new Error(`missing ${what}\n\n${USAGE}`);
	return value;
}

export async function main(
	argv: readonly string[],
	out: (text: string) => void = (text) => process.stdout.write(text),
): Promise<number> {
	const args = parse(argv);
	const [command, sub, target] = args.positional;
	const print = (value: unknown) => out(`${JSON.stringify(value, null, 2)}\n`);
	if (!command || command === "help" || args.flags.has("help")) {
		out(`${USAGE}\n`);
		return 0;
	}
	if (command === "selftest") {
		print(await selftest());
		return 0;
	}
	const lattice = Lattice.open(str(args, "data") ?? defaultDataDir(), {
		adapter: args.flags.has("no-adapter") ? null : undefined,
	});
	let keepOpen = false;
	try {
		switch (command) {
			case "init":
				print(lattice.init());
				break;
			case "status":
				print(lattice.status());
				break;
			case "goal": {
				const input = str(args, "input");
				const result = await lattice.submitGoal({
					contract_id: str(args, "contract"),
					text: str(args, "contract") ? undefined : sub,
					directory: str(args, "dir"),
					input: input ? readJsonFile(input) : undefined,
					constraints: { max_runtime_ms: int(args, "max-ms") },
				});
				print(result);
				return result.status === "completed" ? 0 : 1;
			}
			case "run":
				if (sub !== "skill") throw new Error(USAGE);
				print(lattice.runSkill(need(target, "skill id"), readJsonFile(need(str(args, "input"), "--input FILE"))));
				break;
			case "inspect": {
				const head = lattice.store.head(need(target, "skill id"));
				if (!head) throw new Error(`no skill ${target}`);
				print({ version: head.version, promotion_enabled: head.promotionEnabled, program: head.program });
				break;
			}
			case "explain":
				if (sub === "skill") print(lattice.explainSkill(need(target, "skill id")));
				else if (sub === "episode") print(lattice.explainEpisode(need(target, "episode id")));
				else throw new Error(USAGE);
				break;
			case "improve":
				if (sub === "policy") {
					print(
						await lattice.improveSearchPolicy({
							proposals: int(args, "proposals"),
							budget: int(args, "budget"),
							tasks: int(args, "tasks"),
						}),
					);
				} else if (sub === "skill") {
					print(
						await lattice.improve(need(target, "skill id"), {
							// An explicit request is an exploratory campaign unless --gated asks for the economic gate.
							explore: !args.flags.has("gated"),
							isolate: !args.flags.has("no-isolate"),
							seed: int(args, "seed"),
							policy: str(args, "policy") === "reference" ? "reference" : "active",
							shadowMin: args.flags.has("no-shadow") ? 0 : undefined,
						}),
					);
				} else throw new Error(USAGE);
				break;
			case "test":
				print(lattice.test(need(target, "skill id")));
				break;
			case "rollback":
				print(lattice.rollback(need(target, "skill id"), int(args, "to-version")));
				break;
			case "compile":
				print(lattice.compile(need(target, "skill id")));
				break;
			case "mine":
				print(
					lattice.mine({ keep: int(args, "keep") }).map((report) => ({
						hash: report.hash,
						skill: report.skill,
						occurrences: report.occurrences,
						programs: report.programs,
						gain: report.gain,
						verified_cases: report.verifiedCases,
					})),
				);
				break;
			case "synthesize": {
				const raw = readJsonFile(need(str(args, "examples"), "--examples FILE")) as {
					name: string;
					record_type: Type;
					id_field: string;
					examples: { input: Value; output: Value }[];
				};
				print(
					lattice.synthesize(
						{ name: raw.name, recordType: raw.record_type, idField: raw.id_field, examples: raw.examples },
						{ install: args.flags.has("install") },
					),
				);
				break;
			}
			case "snapshot":
				if (sub === "create") print(lattice.store.createSnapshot(lattice.policy().hash));
				else if (sub === "list") print(lattice.store.listSnapshots());
				else if (sub === "verify") print(lattice.store.verifySnapshot(need(target, "snapshot id")));
				else throw new Error(USAGE);
				break;
			case "policy": {
				const policy = lattice.policy();
				if (sub === "check") {
					const clamped = clampPolicy(policy.record);
					print({
						version: policy.version,
						within_governor_limits: canonical(clamped) === canonical(policy.record),
						integrity: lattice.store.verify().ok,
					});
				} else
					print({
						skill: POLICY_SKILL,
						version: policy.version,
						hash: policy.hash,
						policy: policy.record as SearchPolicy,
					});
				break;
			}
			case "audit":
				if (sub === "verify") print(lattice.store.verify());
				else print(lattice.store.auditLog(str(args, "subject"), int(args, "limit") ?? 50));
				break;
			case "recover":
				print({ recovered: lattice.store.recover(), integrity: lattice.store.verify() });
				break;
			case "maintenance":
				print(lattice.maintenance());
				break;
			case "serve": {
				const { path, token } = serve(lattice, { path: str(args, "path") });
				keepOpen = true;
				print({
					listening: path,
					token_hint: `${token.slice(0, 6)}... (stored in the store meta table as ipc_token)`,
				});
				break;
			}
			default:
				throw new Error(`unknown command ${command}\n\n${USAGE}`);
		}
		return 0;
	} finally {
		if (!keepOpen) lattice.close();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main(process.argv.slice(2)).then(
		(code) => {
			if (code !== 0) process.exitCode = code;
		},
		(error: unknown) => {
			process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		},
	);
}
