import { station } from "./station.js";
import { browserWasm } from "@hobo/provider-browser-wasm";
import { cloudflare } from "@hobo/provider-cloudflare";
import { lakebed } from "@hobo/provider-lakebed";
import { webernetes } from "@hobo/provider-webernetes";

export default station({
	yards: [browserWasm, webernetes, lakebed, cloudflare],
});
