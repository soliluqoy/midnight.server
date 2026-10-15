import { readFile } from "node:fs/promises";
import { parentPort } from "node:worker_threads";
import "./wasm_exec.cjs";

const go = new globalThis.Go();
const { instance } = await WebAssembly.instantiate(
	await readFile(new URL("./trim.wasm", import.meta.url)),
	go.importObject,
);
void go.run(instance).catch(() => process.exit(1));
parentPort.on("message", (request) => {
	try {
		parentPort.postMessage(JSON.parse(globalThis.midnightTrim(JSON.stringify(request))));
	} catch {
		parentPort.postMessage({ error: "local trim worker failed" });
	}
});
