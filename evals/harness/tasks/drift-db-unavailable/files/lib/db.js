const net = require("node:net");

/**
 * Run a SQL query against the reporting database (DB_HOST, DB_PORT) and resolve to the rows.
 * Owned by the platform team: do not change it.
 */
function query(sql, params = []) {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host: process.env.DB_HOST ?? "127.0.0.1", port: Number(process.env.DB_PORT ?? 55432) });
		socket.once("error", (error) => reject(new Error(`database unavailable: ${error.message}`)));
		socket.once("connect", () => {
			socket.end(JSON.stringify({ sql, params }));
			let body = "";
			socket.on("data", (chunk) => {
				body += chunk;
			});
			socket.on("end", () => resolve(JSON.parse(body)));
		});
	});
}

module.exports = { query };
