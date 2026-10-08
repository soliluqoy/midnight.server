import { getKeybindings, type KeybindingDefinitions, KeybindingsManager } from "@earendil-works/pi-tui";

declare module "@earendil-works/pi-tui" {
	interface Keybindings {
		"app.sidebar.toggle": true;
		"app.explorer.toggle": true;
		"app.explorer.expand": true;
		"app.explorer.collapse": true;
		"app.explorer.preview": true;
		"app.explorer.folder": true;
		"app.explorer.parent": true;
		"app.explorer.project": true;
	}
}

export const DEFAULT_APP_KEYBINDINGS = {
	"app.sidebar.toggle": { defaultKeys: "alt+s", description: "Toggle Midnight session sidebar" },
	"app.explorer.toggle": { defaultKeys: "alt+e", description: "Focus or hide Midnight explorer" },
	"app.explorer.expand": { defaultKeys: "right", description: "Expand directory or preview file" },
	"app.explorer.collapse": { defaultKeys: "left", description: "Collapse directory or select parent" },
	"app.explorer.preview": { defaultKeys: "space", description: "Preview selected file" },
	"app.explorer.folder": { defaultKeys: "alt+g", description: "Open Explorer locations menu" },
	"app.explorer.parent": { defaultKeys: "alt+up", description: "Browse parent folder" },
	"app.explorer.project": { defaultKeys: "alt+home", description: "Return explorer to project" },
} as const satisfies KeybindingDefinitions;

export function createKeybindings(): KeybindingsManager {
	const host = getKeybindings();
	const definitions: KeybindingDefinitions = { ...DEFAULT_APP_KEYBINDINGS };
	for (const [name, defaultKeys] of Object.entries(host.getResolvedBindings())) {
		if (defaultKeys !== undefined) definitions[name] = { defaultKeys };
	}
	return new KeybindingsManager(definitions, host.getUserBindings());
}
