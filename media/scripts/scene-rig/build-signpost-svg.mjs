import { readFileSync, writeFileSync } from "node:fs";

// Assemble the rigged signpost SVG from the traced layers. Each arm is a
// <g> rotating a fraction of a degree around its nail on the post; the base
// (post + grass + synthetic bridges behind the boards) never moves.
const { size, layers } = JSON.parse(readFileSync("signpost-layers.json", "utf8"));
const base = layers.find((l) => l.name === "base");
const arms = layers.filter((l) => l.name !== "base");

const layerMarkup = (l, cls) => `
	<g class="${cls}">
		<path class="sp-ink" d="${l.silhouette}"/>
		<path class="sp-light" d="${l.light}"/>
	</g>`;

// wobble: small alternating rotations, desynchronized per arm
const armCss = arms.map((a, k) => {
	const amp = (1.1 + (k % 3) * 0.4).toFixed(1);
	const dur = (5.2 + k * 1.3).toFixed(1);
	const delay = (-k * 1.7).toFixed(1);
	return `.sp-arm${k + 1}{transform-origin:${a.pivot.x}px ${a.pivot.y}px;animation:sp-wobble${k + 1} ${dur}s ease-in-out ${delay}s infinite}
@keyframes sp-wobble${k + 1}{0%,100%{transform:rotate(-${amp}deg)}50%{transform:rotate(${amp}deg)}}`;
}).join("\n");

const svg = `<svg class="signpost" viewBox="0 0 ${size} ${size}" role="img" aria-label="Weathered crossroads signpost with five blank arrow boards, swaying gently">
	<style>
	.signpost .sp-ink{fill:var(--sp-ink,#1a1512)}
	.signpost .sp-light{fill:var(--sp-paper,#ffffff)}
	${armCss}
	@media (prefers-reduced-motion: reduce){.signpost g{animation:none}}
	</style>${arms.map((a, k) => a.behind ? layerMarkup(a, `sp-arm${k + 1}`) : "").join("")}${layerMarkup(base, "sp-base")}${arms.map((a, k) => a.behind ? "" : layerMarkup(a, `sp-arm${k + 1}`)).join("")}
</svg>`;
writeFileSync("signpost-rig.svg", svg);
console.log("signpost-rig.svg", (svg.length / 1024).toFixed(1) + "KB");
