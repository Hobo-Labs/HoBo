/**
 * DESIGN.md colour tokens for the dashboard. The values restate this
 * package's DESIGN.md, which restates HoBo Rubberhose (`site/DESIGN.md`,
 * ADR-0149). The stylesheet interpolates these and nothing else; the
 * design-lint test rejects any other hex in the page.
 */
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

/** Every hex the rendered page may hold. */
export const DASHBOARD_TOKEN_VALUES: ReadonlySet<string> = new Set(
	Object.values(DASHBOARD_TOKENS).map((hex) => hex.toLowerCase()),
);

/** Colours the HoBo design contract forbids on product surfaces: SaaS blues and purples. */
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
