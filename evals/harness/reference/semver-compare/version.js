// Compare two version strings: negative if a < b, 0 if equal, positive if a > b.
function parse(version) {
	const [core, pre] = version.split("+")[0].split(/-(.*)/s);
	return { core: core.split(".").map(Number), pre: pre ? pre.split(".") : [] };
}

function compareIdentifiers(x, y) {
	const nx = /^\d+$/.test(x);
	const ny = /^\d+$/.test(y);
	if (nx && ny) return Number(x) - Number(y);
	if (nx) return -1;
	if (ny) return 1;
	return x < y ? -1 : x > y ? 1 : 0;
}

function compareVersions(a, b) {
	const pa = parse(a);
	const pb = parse(b);
	for (let i = 0; i < 3; i++) {
		if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i];
	}
	if (pa.pre.length === 0 || pb.pre.length === 0) return pb.pre.length - pa.pre.length;
	for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
		if (pa.pre[i] === undefined) return -1;
		if (pb.pre[i] === undefined) return 1;
		const cmp = compareIdentifiers(pa.pre[i], pb.pre[i]);
		if (cmp !== 0) return cmp;
	}
	return 0;
}

module.exports = { compareVersions };
