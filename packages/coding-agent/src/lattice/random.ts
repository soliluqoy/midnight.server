/**
 * MT19937 with the seeding and sampling rules of CPython's `random.Random`, so fixtures and
 * bootstrap resamples reproduce the Python reference implementation (spec section 27.2)
 * value for value. Every campaign persists its seeds, so a run can be replayed exactly.
 */
export class PyRandom {
	private readonly state = new Uint32Array(624);
	private index = 625;

	constructor(seed: number) {
		this.seed(seed);
	}

	private initGenrand(s: number): void {
		const mt = this.state;
		mt[0] = s >>> 0;
		for (let i = 1; i < 624; i++) {
			const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
			mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
		}
		this.index = 624;
	}

	private seed(seed: number): void {
		if (!Number.isSafeInteger(seed)) throw new Error("seed must be a safe integer");
		let rest = BigInt(Math.abs(seed));
		const key: number[] = [];
		while (rest > 0n) {
			key.push(Number(rest & 0xffffffffn));
			rest >>= 32n;
		}
		if (key.length === 0) key.push(0);
		this.initGenrand(19650218);
		const mt = this.state;
		let i = 1;
		let j = 0;
		for (let k = Math.max(624, key.length); k > 0; k--) {
			const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
			mt[i] = ((mt[i] ^ Math.imul(prev, 1664525)) + key[j] + j) >>> 0;
			i++;
			j++;
			if (i >= 624) {
				mt[0] = mt[623];
				i = 1;
			}
			if (j >= key.length) j = 0;
		}
		for (let k = 623; k > 0; k--) {
			const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
			mt[i] = ((mt[i] ^ Math.imul(prev, 1566083941)) - i) >>> 0;
			i++;
			if (i >= 624) {
				mt[0] = mt[623];
				i = 1;
			}
		}
		mt[0] = 0x80000000;
	}

	private next32(): number {
		const mt = this.state;
		if (this.index >= 624) {
			for (let k = 0; k < 624; k++) {
				const y = (mt[k] & 0x80000000) | (mt[(k + 1) % 624] & 0x7fffffff);
				mt[k] = (mt[(k + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0)) >>> 0;
			}
			this.index = 0;
		}
		let y = mt[this.index++];
		y ^= y >>> 11;
		y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0;
		y = (y ^ ((y << 15) & 0xefc60000)) >>> 0;
		y ^= y >>> 18;
		return y >>> 0;
	}

	/** Uniform float in [0, 1) with 53 random bits. */
	random(): number {
		const a = this.next32() >>> 5;
		const b = this.next32() >>> 6;
		return (a * 67108864 + b) / 9007199254740992;
	}

	private getrandbits(k: number): number {
		return this.next32() >>> (32 - k);
	}

	/** Uniform integer in [0, n), by rejection like CPython `_randbelow_with_getrandbits`. */
	below(n: number): number {
		if (!Number.isInteger(n) || n <= 0 || n > 0xffffffff) throw new Error("below() needs 0 < n <= 2^32 - 1");
		const k = 32 - Math.clz32(n);
		let r = this.getrandbits(k);
		while (r >= n) r = this.getrandbits(k);
		return r;
	}

	/** Inclusive on both ends, like `randint`. */
	randint(a: number, b: number): number {
		return a + this.below(b - a + 1);
	}

	randrange(stop: number): number {
		return this.below(stop);
	}

	choice<T>(items: readonly T[]): T {
		return items[this.below(items.length)];
	}

	/** `choices(items, k=k)` without weights: sampling with replacement. */
	choices<T>(items: readonly T[], k: number): T[] {
		const out: T[] = [];
		for (let i = 0; i < k; i++) out.push(items[Math.floor(this.random() * items.length)]);
		return out;
	}
}

/** Mean with compensated summation, so long vectors of gains do not accumulate rounding error. */
export function mean(values: readonly number[]): number {
	if (values.length === 0) throw new Error("mean of an empty list");
	let sum = 0;
	let compensation = 0;
	for (const value of values) {
		const t = sum + value;
		compensation += Math.abs(sum) >= Math.abs(value) ? sum - t + value : value - t + sum;
		sum = t;
	}
	return (sum + compensation) / values.length;
}
