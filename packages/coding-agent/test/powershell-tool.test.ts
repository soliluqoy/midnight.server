import { describe, expect, it } from "vitest";
import { createPowerShellTool } from "../src/core/tools/powershell.ts";
import { getPowerShellConfig, POWERSHELL_ARGS } from "../src/utils/shell.ts";

function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((content) => content.type === "text")
		.map((content) => content.text ?? "")
		.join("\n");
}

describe("powershell tool", () => {
	it("uses process-local execution policy bypass", () => {
		expect(POWERSHELL_ARGS).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]);
	});

	it.skipIf(process.platform !== "win32")("executes PowerShell commands with UTF-8 output", async () => {
		const config = getPowerShellConfig();
		expect(config.args).toEqual(POWERSHELL_ARGS);

		const tool = createPowerShellTool(process.cwd());
		const result = await tool.execute("powershell-test", {
			command: "Write-Output 'héllo €'; Get-ExecutionPolicy -Scope Process",
		});
		const output = getTextOutput(result);

		expect(output).toContain("héllo €");
		expect(output).toContain("Bypass");
	});

	it.skipIf(process.platform !== "win32")("reports a native command's exit code instead of 1", async () => {
		const tool = createPowerShellTool(process.cwd());
		const exitCode = async (command: string) => {
			const result = await tool.execute("exit-code", { command });
			const code = /Command exited with code (\d+)/.exec(getTextOutput(result))?.[1];
			return { code: code === undefined ? 0 : Number(code), isError: result.isError === true };
		};
		expect(await exitCode('node -e "process.exit(3)"')).toEqual({ code: 3, isError: true });
		expect(await exitCode("Get-Item does-not-exist-harness")).toEqual({ code: 1, isError: true });
		expect(await exitCode("exit 9")).toEqual({ code: 9, isError: true });
		expect(await exitCode('node -e "process.exit(0)"; Write-Output done')).toEqual({ code: 0, isError: false });
	});
});
