import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const go = process.env.GO_BINARY || "go";
const version = execFileSync(go, ["version"], { encoding: "utf8" });
if (!version.includes("go1.27.2 ")) throw new Error("Rebuild with pinned Go 1.27.2.");
const hash = createHash("sha256")
	.update(readFileSync(join(root, "vendor/trim-1/model.bin")))
	.digest("hex");
if (hash !== "75478721d9992c3cbe6a1874ddf363ae6d78935a1fa526fb6fac1d0f6f3cdc2d")
	throw new Error("Unexpected Trim-1 model hash.");
execFileSync(
	go,
	["build", "-trimpath", "-ldflags=-s -w -buildid=", "-o", join(root, "src/trim/trim.wasm"), "./cmd/midnight"],
	{
		cwd: join(root, "vendor/trim-1"),
		env: { ...process.env, GOOS: "js", GOARCH: "wasm", CGO_ENABLED: "0", GOTOOLCHAIN: "local", GOPROXY: "off" },
		stdio: "inherit",
	},
);
const goroot = execFileSync(go, ["env", "GOROOT"], { encoding: "utf8" }).trim();
copyFileSync(join(goroot, "lib/wasm/wasm_exec.js"), join(root, "src/trim/wasm_exec.cjs"));
console.log("Rebuilt bundled Trim-1 WASM and Go runtime; no install-time build is required.");
