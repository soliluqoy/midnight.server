const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Call fn until it succeeds, at most retries + 1 times, waiting baseDelayMs * 2^n between attempts.
// Errors with retryable === false are thrown immediately.
async function retry(fn, { retries = 3, baseDelayMs = 100, sleep = defaultSleep } = {}) {
	for (let attempt = 0; ; attempt++) {
		try {
			return await fn();
		} catch (error) {
			if (attempt >= retries || error?.retryable === false) throw error;
			await sleep(baseDelayMs * 2 ** attempt);
		}
	}
}

module.exports = { retry };
