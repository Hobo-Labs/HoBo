export const STATUS_PAGE_TOKENS = {
	ink: "#101010",
	paper: "#ffffff",
	mute: "#4a4a46",
	cream: "#f2f1ec",
	spark: "#c5301c",
	go: "#14672c",
	soot: "#1a1512",
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

export type StatusPageTokenName = keyof typeof STATUS_PAGE_TOKENS;

export const STATUS_PAGE_TOKEN_VALUES: ReadonlySet<string> = new Set(
	Object.values(STATUS_PAGE_TOKENS).map((hex) => hex.toLowerCase()),
);

export const STATUS_PAGE_FORBIDDEN_HEX = [
	"#0070f3",
	"#3b82f6",
	"#2563eb",
	"#6366f1",
	"#8b5cf6",
	"#a855f7",
	"#7c3aed",
	"#00d4ff",
	"#22d3ee",
	"#9bc7ff",
	"#8bd5ca",
	"#171512",
	"#756954",
	"#d7a84b",
	"#7ecb79",
	"#df6b57",
	"#f5a97f",
	"#ed8796",
	"#a6da95",
] as const;
