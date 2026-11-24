export const DASHBOARD_TOKENS = {
	ink: "#101010",
	paper: "#ffffff",
	mute: "#4a4a46",
	cream: "#f2f1ec",
	spark: "#c5301c",
	go: "#14672c",
	faint: "#6e6d68",
	border: "#e3e2de",
	borderStrong: "#c9c8c2",
	inset: "#f4f4f2",
	codeBg: "#f7f7f5",
	nightBg: "#0a0a0a",
	nightRaised: "#111111",
	nightSpark: "#ff7a63",
	nightGo: "#57c777",
} as const;

export const DASHBOARD_TOKEN_VALUES: ReadonlySet<string> = new Set(
	Object.values(DASHBOARD_TOKENS).map((hex) => hex.toLowerCase()),
);

export const DASHBOARD_FORBIDDEN_HEX = [
	"#0070f3",
	"#3b82f6",
	"#2563eb",
	"#6366f1",
	"#8b5cf6",
	"#a855f7",
	"#7c3aed",
	"#00d4ff",
	"#22d3ee",
] as const;
