#!/usr/bin/env node
import { setupCli } from "./cli/setup.ts";
import { main } from "./main.ts";
import { runMidnightCommand } from "./midnight/commands.ts";
import { LocalInferenceUnavailableError, prepareLocalRuntime } from "./midnight/local-runtime.ts";
import { reportMidnightActivity } from "./midnight/status.ts";

setupCli();
try {
	const args = process.argv.slice(2);
	const exitCode = await runMidnightCommand(args);
	if (exitCode !== undefined) {
		process.exitCode = exitCode;
	} else {
		const runtime = await prepareLocalRuntime(args, { onStatus: reportMidnightActivity });
		try {
			await main(runtime.args, { extensionFactories: runtime.extensionFactories });
		} finally {
			await runtime.stop();
		}
	}
} catch (error) {
	if (error instanceof LocalInferenceUnavailableError) {
		console.error(`Error: ${error.message}`);
		process.exitCode = 1;
	} else {
		throw error;
	}
}
