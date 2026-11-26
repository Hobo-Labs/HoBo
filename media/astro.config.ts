import { defineConfig } from "astro/config";

// Published under /HoBo/media/ so it can sit beside the main site on the same
// GitHub Pages origin without a second domain.
export default defineConfig({
	site: "https://tyler-r-kendrick.github.io",
	base: "/HoBo/media",
	trailingSlash: "always",
	build: { format: "directory" },
});
