import { defineConfig } from "astro/config";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeSlug from "rehype-slug";

import { temporaryStationApiPlugin } from "./scripts/vite-temporary-station-api.mts";

export default defineConfig({
	site: "https://tyler-r-kendrick.github.io",
	base: "/HoBo",
	trailingSlash: "ignore",
	vite: {
		plugins: [temporaryStationApiPlugin()],
		esbuild: {
			supported: { decorators: false },
		},
	},
	markdown: {
		rehypePlugins: [
			rehypeSlug,
			[
				rehypeAutolinkHeadings,
				{
					behavior: "append",
					properties: { class: "heading-anchor", ariaHidden: "true", tabIndex: -1 },
					content: { type: "text", value: "#" },
				},
			],
		],
		shikiConfig: {
			themes: {
				light: "github-light-high-contrast",
				dark: "github-dark-high-contrast",
			},
			defaultColor: false,
		},
	},
});
