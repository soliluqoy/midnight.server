import { describe, expect, it } from "vitest";
import { sanitizeBinaryOutput } from "../src/utils/shell.ts";

/** The previous per-code-point implementation, minus its lone-surrogate gap. */
function reference(str: string): string {
	return Array.from(str)
		.filter((char) => {
			const code = char.codePointAt(0);
			if (code === undefined) return false;
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
			if (code <= 0x1f) return false;
			if (code >= 0xd800 && code <= 0xdfff) return false;
			if (code >= 0xfff9 && code <= 0xfffb) return false;
			return true;
		})
		.join("");
}

describe("sanitizeBinaryOutput", () => {
	it("keeps tab, newline, carriage return and printable text, emoji included", () => {
		expect(sanitizeBinaryOutput("a\tb\nc\r\nd 😀 é")).toBe("a\tb\nc\r\nd 😀 é");
	});

	it("drops other control characters, format characters and lone surrogates", () => {
		expect(sanitizeBinaryOutput("a\x00b\x07c\x1bd\x7fe")).toBe("abcd\x7fe");
		expect(sanitizeBinaryOutput("x￹y￻z")).toBe("xyz");
		expect(sanitizeBinaryOutput("lone \ud800 high, lone \udc00 low, pair 😀")).toBe("lone  high, lone  low, pair 😀");
	});

	it("returns the same string when there is nothing to remove", () => {
		const text = "plain output\nwith lines";
		expect(sanitizeBinaryOutput(text)).toBe(text);
	});

	it("matches the per-code-point filter on random input", () => {
		let seed = 42;
		const random = () => {
			seed = (seed * 1103515245 + 12345) % 2 ** 31;
			return seed / 2 ** 31;
		};
		const pool = [0x00, 0x07, 0x09, 0x0a, 0x0d, 0x1b, 0x1f, 0x20, 0x41, 0x7f, 0xe9, 0xd800, 0xdc00, 0xfff9, 0xfffc];
		for (let i = 0; i < 2_000; i++) {
			let str = "";
			for (let j = 0; j < 20; j++) {
				str += random() < 0.1 ? "😀" : String.fromCharCode(pool[Math.floor(random() * pool.length)]!);
			}
			expect(sanitizeBinaryOutput(str)).toBe(reference(str));
		}
	});
});
