/**
 * Canonical Environment Station deploy sample for the Examples console.
 * Pool Code synthesizes this shape from the current provision plan.
 *
 * Local `./station.js` re-exports `environmentStation` as `station` so the
 * call matches the provider-extension DX without changing ADR-0131 Bindles.
 */
import { station } from "./station.js";
import { browserWasm } from "@hobo/provider-browser-wasm";
import { cloudflare } from "@hobo/provider-cloudflare";
import { lakebed } from "@hobo/provider-lakebed";
import { webernetes } from "@hobo/provider-webernetes";

export default station({
	yards: [browserWasm, webernetes, lakebed, cloudflare],
});
