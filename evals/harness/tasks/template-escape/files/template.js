// Render "{{name}}" placeholders from data. "{{{name}}}" inserts raw HTML.
function render(template, data) {
	return template
		.replace(/\{\{\{(\w+)\}\}\}/g, (_, key) => String(data[key] ?? ""))
		.replace(/\{\{(\w+)\}\}/g, (_, key) => String(data[key] ?? ""));
}

module.exports = { render };
