import {
	isForbiddenSecretEnvKey,
	looksLikeSecretEnvValue,
} from "@hobo/bindles";

// Only forward the platform's desktop/session and ordinary process locations.
// Arbitrary application variables and loader hooks do not reach the opener.
const BROWSER_ENV_NAMES: ReadonlySet<string> = new Set([
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"LANG",
	"LANGUAGE",
	"LC_ALL",
	"LC_CTYPE",
	"LC_MESSAGES",
	"DISPLAY",
	"WAYLAND_DISPLAY",
	"XAUTHORITY",
	"XDG_RUNTIME_DIR",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CONFIG_DIRS",
	"XDG_DATA_DIRS",
	"XDG_CURRENT_DESKTOP",
	"XDG_SESSION_DESKTOP",
	"XDG_SESSION_TYPE",
	"DESKTOP_SESSION",
	"DBUS_SESSION_BUS_ADDRESS",
	"SYSTEMROOT",
	"WINDIR",
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA",
	"TEMP",
	"TMP",
	"TMPDIR",
]);

export function browserEnvironment(
	env: Readonly<Record<string, string | undefined>>,
) {
	const kept: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) {
		const lookup = process.platform === "win32" ? name.toUpperCase() : name;
		if (
			value !== undefined &&
			BROWSER_ENV_NAMES.has(lookup) &&
			!isForbiddenSecretEnvKey(name) &&
			!looksLikeSecretEnvValue(value)
		)
			kept[name] = value;
	}
	return kept;
}
