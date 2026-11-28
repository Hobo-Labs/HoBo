export interface Challenge {
	readonly scheme: string;
	readonly params: Readonly<Record<string, string>>;
}

export function parseChallenge(value: string | undefined): Challenge {
	if (value === undefined) return { scheme: "", params: {} };
	const trimmed = value.trim();
	const space = trimmed.indexOf(" ");
	const scheme = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase();
	const params: Record<string, string> = {};
	const rest = space < 0 ? "" : trimmed.slice(space + 1);
	for (const match of rest.matchAll(/([A-Za-z_]+)="([^"]{0,2048})"/gu)) {
		const [, key, raw] = match;
		if (key !== undefined && raw !== undefined) params[key.toLowerCase()] = raw;
	}
	return { scheme, params };
}
