const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Call fn until it succeeds. options: { retries = 3, baseDelayMs = 100, sleep }.
async function retry(fn, { retries = 3, baseDelayMs = 100, sleep = defaultSleep } = {}) {
	for (;;) {
		try {
			return await fn();
		} catch (error) {
			if (retries-- < 0) throw error;
		}
	}
}

module.exports = { retry };
