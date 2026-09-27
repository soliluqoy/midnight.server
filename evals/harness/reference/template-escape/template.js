// Render "{{name}}" placeholders from data, HTML-escaped. "{{{name}}}" inserts raw HTML.
const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (text) => text.replace(/[&<>"']/g, (char) => ESCAPES[char]);

function render(template, data) {
	return template.replace(/\{\{\{(\w+)\}\}\}|\{\{(\w+)\}\}/g, (_, raw, escaped) =>
		raw !== undefined ? String(data[raw] ?? "") : escapeHtml(String(data[escaped] ?? "")),
	);
}

module.exports = { render };
