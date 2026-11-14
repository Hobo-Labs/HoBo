import { bindle } from "@hobo/bindles";

// A Bindle whose `auth` someone else runs: placing it would put an external
// in a Yard, so plan and up refuse it.
export default bindle("external-bindle", (b) => ({
	api: b.api(),
	auth: b.external({ endpoints: { issuer: "https://auth.example.com" } }),
}));
