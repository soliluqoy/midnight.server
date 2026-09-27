const routes = new Map();

function route(method, path, handler) {
	routes.set(`${method} ${path}`, handler);
}

function dispatch(method, path, request) {
	const handler = routes.get(`${method} ${path}`);
	if (!handler) return { status: 404 };
	return { status: 200, body: handler(request) };
}

module.exports = { route, dispatch };
