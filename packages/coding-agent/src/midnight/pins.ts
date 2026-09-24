import type { ModelLock } from "./model-integrity.ts";

/**
 * Pinned artifacts compiled into the executable. The JSON locks under
 * `models/` and `engine/` mirror these values for scripts; a test keeps them equal.
 */
export const MODEL_LOCK: ModelLock = {
	modelId: "openbmb/MiniCPM5-2B",
	repository: "openbmb/MiniCPM5-2B-GGUF",
	revision: "2079a22f3beaa4e306449978533478fe0522f4b3",
	fileName: "MiniCPM5-2B-Q8_0.gguf",
	sizeBytes: 2679710688,
	sha256: "c5415f8989bf88a8288f1b55a3cc371af53c07b0faa220a63bd7a990cfaba078",
};

export interface EngineLock {
	name: string;
	release: string;
	commit: string;
	backend: "cpu";
	platform: "win32-x64";
	url: string;
	sizeBytes: number;
	sha256: string;
	/** Files extracted from the archive. Everything else (other tools) is left out. */
	files: string[];
}

export const ENGINE_LOCK: EngineLock = {
	name: "llama.cpp",
	release: "b11166",
	commit: "a72e04abe0fe9b36e203033ac71bd5f379c35bc5",
	backend: "cpu",
	platform: "win32-x64",
	url: "https://github.com/ggml-org/llama.cpp/releases/download/b11166/llama-b11166-bin-win-cpu-x64.zip",
	sizeBytes: 18567816,
	sha256: "a9372816f6cff6a6f16ebdc22e9fdcd6da6ab42838bc5c082a0c6ad92633f84a",
	files: [
		"llama-server.exe",
		"llama-server-impl.dll",
		"llama-common.dll",
		"llama.dll",
		"mtmd.dll",
		"ggml.dll",
		"ggml-base.dll",
		"ggml-cpu-alderlake.dll",
		"ggml-cpu-cannonlake.dll",
		"ggml-cpu-cascadelake.dll",
		"ggml-cpu-cooperlake.dll",
		"ggml-cpu-haswell.dll",
		"ggml-cpu-icelake.dll",
		"ggml-cpu-ivybridge.dll",
		"ggml-cpu-piledriver.dll",
		"ggml-cpu-sandybridge.dll",
		"ggml-cpu-sapphirerapids.dll",
		"ggml-cpu-skylakex.dll",
		"ggml-cpu-sse42.dll",
		"ggml-cpu-x64.dll",
		"ggml-cpu-zen4.dll",
		"libomp.dll",
		"LICENSE-LLVM-OpenMP",
	],
};

export function modelDownloadUrl(lock: ModelLock): string {
	return `https://huggingface.co/${lock.repository}/resolve/${lock.revision}/${lock.fileName}`;
}

/** Provider and model ids registered for the embedded engine. */
export const LOCAL_PROVIDER_ID = "midnight";
export const LOCAL_MODEL_ID = "minicpm5-2b-q8_0";
