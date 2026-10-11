import { fileURLToPath, pathToFileURL } from "node:url";
import { serveMcp } from "./mcp.ts";
import { claudeStatusLine } from "./statusline.ts";
import { callTool, cleanText } from "./workspace.ts";

const help = `Midnight native client tools (Node 22.19+ and Git)

  node --experimental-strip-types src/clients/cli.ts mcp
  node --experimental-strip-types src/clients/cli.ts status [--cwd DIR]
  node --experimental-strip-types src/clients/cli.ts list [PATH] [--cwd DIR]
  node --experimental-strip-types src/clients/cli.ts preview PATH [--cwd DIR]
  node --experimental-strip-types src/clients/cli.ts diff PATH [--layer staged|unstaged] [--cwd DIR]
  node --experimental-strip-types src/clients/cli.ts statusline < claude-session.json
  node --experimental-strip-types src/clients/cli.ts config claude|codex

Status/list/preview/diff return JSON. --offset N and --limit N paginate results.
Config prints a settings fragment; merge it with your settings. It writes nothing.
Claude Code also provides /midnight-sidebar. Codex sidebars require the separate Midnight CLI fork.
`;

export function configuration(client: string, entry = fileURLToPath(import.meta.url)): string {
	if (client === "claude") {
		// A base64 file URL keeps shell metacharacters in checkout paths out of command syntax.
		const encoded = Buffer.from(pathToFileURL(entry).href).toString("base64");
		const loader = `import(Buffer.from('${encoded}','base64').toString())`;
		return JSON.stringify(
			{
				statusLine: {
					type: "command",
					command: `node --experimental-strip-types --input-type=module -e "${loader}" -- statusline`,
				},
			},
			null,
			2,
		);
	}
	if (client === "codex") {
		return [
			"# Merge with existing tables; do not create a duplicate [tui] table.",
			"[tui]",
			'status_line = ["model", "context-remaining", "git-branch"]',
			"",
			"# Only needed when using the MCP server without the installed Midnight plugin.",
			"[mcp_servers.midnight]",
			'command = "node"',
			`args = ${JSON.stringify(["--experimental-strip-types", entry, "mcp"])}`,
		].join("\n");
	}
	throw new Error("Choose config claude or config codex.");
}

async function main(argv: string[]) {
	const [command, ...rest] = argv;
	if (!command || command === "help" || command === "--help" || command === "-h") {
		process.stdout.write(help);
		return;
	}
	if (command === "mcp") {
		if (rest.length) throw new Error("mcp takes no arguments; tools receive cwd from the client.");
		await serveMcp(process.stdin, process.stdout);
		return;
	}
	if (command === "config") {
		if (rest.length !== 1) throw new Error("Choose config claude or config codex.");
		process.stdout.write(`${configuration(rest[0])}\n`);
		return;
	}
	if (command === "statusline") {
		if (rest.length || process.stdin.isTTY) throw new Error("statusline reads Claude Code's JSON from stdin.");
		const chunks: Buffer[] = [];
		let bytes = 0;
		for await (const chunk of process.stdin) {
			bytes += chunk.length;
			if (bytes > 256 * 1024) throw new Error("Status input exceeds 256 KiB.");
			chunks.push(Buffer.from(chunk));
		}
		const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		process.stdout.write(`${await claudeStatusLine(data)}\n`);
		return;
	}
	if (!["status", "list", "preview", "diff"].includes(command)) throw new Error(`Unknown command: ${command}`);
	const args: Record<string, unknown> = { cwd: process.cwd() };
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (["--cwd", "--offset", "--limit", "--layer"].includes(arg)) {
			const value = rest[++i];
			if (value === undefined) throw new Error(`Missing value after ${arg}.`);
			args[arg.slice(2)] = arg === "--offset" || arg === "--limit" ? Number(value) : value;
		} else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
		else if (args.path === undefined) args.path = arg;
		else throw new Error("Expected one path. Quote paths that contain spaces.");
	}
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		const result = await callTool(`midnight_${command}`, args, controller.signal);
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} finally {
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
	}
}

// The generated status-line loader uses -e, where argv starts at the command itself.
const invoked =
	process.argv[1] === "statusline" || (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url);
if (invoked) {
	main(process.argv.slice(process.argv[1] === "statusline" ? 1 : 2)).catch((cause) => {
		process.stderr.write(`Midnight: ${cleanText(cause instanceof Error ? cause.message : String(cause))}\n`);
		process.exitCode = 1;
	});
}
