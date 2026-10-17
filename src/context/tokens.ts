export function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(2))}m`;
	if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}k`;
	return String(value);
}

export function parseTokenCount(text: string): number {
	const match = text
		.trim()
		.toLowerCase()
		.replace(/[_,]/g, "")
		.match(/^(\d+(?:\.\d+)?)([km])?$/);
	if (!match) throw new Error(`expected a number of tokens like 200k, got "${text}"`);
	const value = Number(match[1]) * (match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1);
	return Math.round(value);
}

export function parseReminders(text: string): number[] {
	const value = text.trim().toLowerCase();
	if (value === "off" || value === "none") return [];
	const parts = value
		.replace(/%/g, "")
		.split(/[\s,/]+/)
		.filter(Boolean)
		.map(Number);
	if (parts.length === 0 || parts.some((part) => !Number.isFinite(part))) {
		throw new Error(`reminders must be percentages like 50/75/90 or "off", got "${text}"`);
	}
	const fractions = parts.map((part) => (part > 1 ? part / 100 : part));
	if (fractions.some((fraction) => fraction <= 0 || fraction >= 1))
		throw new Error("reminder percentages must be between 0 and 100");
	return [...new Set(fractions)].sort((left, right) => left - right);
}
