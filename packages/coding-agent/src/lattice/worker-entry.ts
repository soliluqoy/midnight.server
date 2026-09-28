import { parentPort, workerData } from "node:worker_threads";
import { handleRequest, type WorkerRequest } from "./worker.ts";

// Worker thread entry: answer exactly one request, then the parent terminates the thread.
parentPort?.postMessage(handleRequest(workerData as WorkerRequest));
