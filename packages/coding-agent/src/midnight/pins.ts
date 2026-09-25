import { ENGINE_BUILDS, ENGINE_RELEASE } from "./engine-builds.generated.ts";
import type { ModelLock } from "./model-integrity.ts";

/**
 * Pinned artifacts compiled into the executable. The JSON lock under `models/`
 * mirrors MODEL_LOCK for scripts; a test keeps them equal. Engine builds are
 * generated from a llama.cpp release by scripts/generate-engine-pins.mjs.
 */
export const MODEL_LOCK: ModelLock = {
	modelId: "openbmb/MiniCPM5-2B",
	repository: "openbmb/MiniCPM5-2B-GGUF",
	revision: "2079a22f3beaa4e306449978533478fe0522f4b3",
	fileName: "MiniCPM5-2B-Q8_0.gguf",
	sizeBytes: 2679710688,
	sha256: "c5415f8989bf88a8288f1b55a3cc371af53c07b0faa220a63bd7a990cfaba078",
};

export const ENGINE_PLATFORMS = [
	"win32-x64",
	"win32-arm64",
	"linux-x64",
	"linux-arm64",
	"darwin-x64",
	"darwin-arm64",
] as const;
export type EnginePlatform = (typeof ENGINE_PLATFORMS)[number];

/** llama.cpp build flavors. `cuda-12`/`cuda-13` differ in the minimum NVIDIA driver they need. */
export const ENGINE_BACKENDS = [
	"cpu",
	"metal",
	"vulkan",
	"cuda-12",
	"cuda-13",
	"rocm",
	"sycl",
	"openvino",
	"opencl",
	"hexagon",
] as const;
export type EngineBackend = (typeof ENGINE_BACKENDS)[number];

export interface EngineArchive {
	url: string;
	sizeBytes: number;
	sha256: string;
}

export interface EngineRelease {
	name: string;
	release: string;
	commit: string;
}

export type EngineBuilds = Record<EnginePlatform, Partial<Record<EngineBackend, EngineArchive[]>>>;

/** One installable engine: every archive is extracted into the same directory, in order. */
export interface EngineLock extends EngineRelease {
	platform: EnginePlatform;
	backend: EngineBackend;
	archives: EngineArchive[];
}

export function currentEnginePlatform(): EnginePlatform | undefined {
	const platform = `${process.platform}-${process.arch}`;
	return (ENGINE_PLATFORMS as readonly string[]).includes(platform) ? (platform as EnginePlatform) : undefined;
}

export function engineLock(
	backend: EngineBackend,
	platform: EnginePlatform | undefined = currentEnginePlatform(),
): EngineLock | undefined {
	const archives = platform ? ENGINE_BUILDS[platform][backend] : undefined;
	return platform && archives ? { ...ENGINE_RELEASE, platform, backend, archives } : undefined;
}

export function availableBackends(platform: EnginePlatform | undefined = currentEnginePlatform()): EngineBackend[] {
	return platform ? ENGINE_BACKENDS.filter((backend) => ENGINE_BUILDS[platform][backend]) : [];
}

/**
 * The backend that runs on the CPU alone for a platform. On Apple Silicon the
 * only build is Metal, which runs on the CPU with zero GPU layers.
 */
export function cpuBackend(platform: EnginePlatform | undefined = currentEnginePlatform()): EngineBackend {
	return platform === "darwin-arm64" ? "metal" : "cpu";
}

/** Parse a user-supplied backend name. `cuda` means whichever CUDA build the platform has, oldest first. */
export function parseBackend(
	name: string,
	platform: EnginePlatform | undefined = currentEnginePlatform(),
): EngineBackend | undefined {
	const available = availableBackends(platform);
	if (name === "cuda") return available.find((backend) => backend.startsWith("cuda-"));
	return available.find((backend) => backend === name);
}

export function engineDownloadBytes(lock: EngineLock): number {
	return lock.archives.reduce((sum, archive) => sum + archive.sizeBytes, 0);
}

export function modelDownloadUrl(lock: ModelLock): string {
	return `https://huggingface.co/${lock.repository}/resolve/${lock.revision}/${lock.fileName}`;
}

/** Provider and model ids registered for the embedded engine. */
export const LOCAL_PROVIDER_ID = "midnight";
export const LOCAL_MODEL_ID = "minicpm5-2b-q8_0";
