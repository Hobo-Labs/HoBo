import { readFileSync, writeFileSync } from "node:fs";

// Emit the live Crossroads.astro from the approved, traced signpost layers.
const { size, layers } = JSON.parse(readFileSync("signpost-layers.json", "utf8"));
const base = layers.find((l) => l.name === "base");
const arms = layers.filter((l) => l.name !== "base");
const behind = arms.filter((a) => a.behind);
const front = arms.filter((a) => !a.behind);

const g = (l, cls) => `<g class="${cls}"><path class="xr-ink" d="${l.silhouette}"></path><path class="xr-lit" d="${l.light}"></path></g>`;

const armCss = arms.map((a) => {
	const k = Number(a.name.slice(3));
	const amp = (1.1 + ((k - 1) % 3) * 0.4).toFixed(1);
	const dur = (5.2 + (k - 1) * 1.3).toFixed(1);
	const delay = (-(k - 1) * 1.7).toFixed(1);
	return `	.xr-${a.name} {
		transform-box: view-box;
		transform-origin: ${a.pivot.x}px ${a.pivot.y}px;
		animation: xr-wobble${k} ${dur}s ease-in-out ${delay}s infinite;
	}
	@keyframes xr-wobble${k} {
		0%, 100% { transform: rotate(-${amp}deg); }
		50% { transform: rotate(${amp}deg); }
	}`;
}).join("\n");

const astro = `---
// "crossroads" scene — the approved signpost prop (media/public/reference/
// scene-props/signpost.webp), machine-traced into six rigged layers: the post
// and grass stay planted while each arrow board wobbles a degree or two
// around its own nail. The short broken board passes BEHIND the post exactly
// as drawn, so it renders under the base and z-order does the occlusion.
// Composed with the supplied parallax plates, cloud sprites, and Bo's idle
// strip — all approved media, nothing generated here.
//
// Night rule (same as the mascot): prop ink never inverts — it lifts to soot
// and gains a light rim; board whites stay white. The plates invert to chalk
// and the clouds keep their own ink, matching the trail band's layer policy (site/src/lib/trail-plates.ts).
import BoIdle from "../BoIdle.astro";
import { href } from "../../lib/url";
const plate = (f: string) => \`--img: url("\${href(\`/parallax/plates/\${f}\`)}")\`;
const cloud = (f: string) => href(\`/parallax/clouds/\${f}\`);
---

<figure class="scene scene-crossroads">
	<div
		class="xr-stage"
		role="img"
		aria-label="Bo the bindlebug idling at a crossroads while a weathered signpost of blank arrows sways gently under a drifting sky"
	>
		<div class="xr-plate xr-sky" style={plate("sky.png")}></div>
		<img class="xr-cloud xr-c1" src={cloud("cloud-1.png")} alt="" loading="lazy" />
		<img class="xr-cloud xr-c2" src={cloud("cloud-2.png")} alt="" loading="lazy" />
		<img class="xr-cloud xr-c3" src={cloud("cloud-3.png")} alt="" loading="lazy" />
		<div class="xr-plate xr-hills" style={plate("hills.png")}></div>
		<div class="xr-plate xr-trail" style={plate("trail.png")}></div>
		<div class="xr-bo"><BoIdle size="clamp(4.75rem, 13vw, 7.5rem)" /></div>
		<div class="xr-post">
			<svg viewBox="0 0 ${size} ${size}" aria-hidden="true">
				${behind.map((a) => g(a, `xr-${a.name}`)).join("\n\t\t\t\t")}
				${g(base, "xr-base")}
				${front.map((a) => g(a, `xr-${a.name}`)).join("\n\t\t\t\t")}
			</svg>
		</div>
	</div>
</figure>

<style>
	.xr-stage {
		--stage-h: clamp(260px, 42vw, 400px);
		position: relative;
		height: var(--stage-h);
		overflow: hidden;
		border: var(--rule, 2.5px) solid var(--ink);
		border-radius: 10px;
		background: #ffffff;
	}

	/* Plates tile horizontally; each drifts by exactly one tile per cycle so
	   the loop is seamless at any stage height. --ar is the tile's natural
	   width/height ratio. */
	.xr-plate {
		position: absolute;
		inset: 0;
		background-image: var(--img);
		background-repeat: repeat-x;
		background-size: calc(var(--stage-h) * var(--ar)) 100%;
		animation: xr-drift var(--dur) linear infinite;
	}
	.xr-sky { --ar: 4.9233; --dur: 160s; }
	.xr-hills { --ar: 2.85; --dur: 110s; }
	.xr-trail { --ar: 3.1633; --dur: 80s; }
	@keyframes xr-drift {
		from { background-position-x: 0; }
		to { background-position-x: calc(-1 * var(--stage-h) * var(--ar)); }
	}

	/* Clouds cross the whole stage; both keyframe ends are off-screen, so the
	   loop restart can never be seen. Negative delays spread them mid-flight. */
	.xr-cloud {
		position: absolute;
		left: 100%;
		animation: xr-float var(--dur) linear infinite;
	}
	.xr-c1 { width: clamp(110px, 22%, 180px); top: 8%; --dur: 120s; animation-delay: -85s; }
	.xr-c2 { width: clamp(72px, 15%, 120px); top: 21%; --dur: 95s; animation-delay: -30s; }
	.xr-c3 { width: clamp(86px, 17%, 140px); top: 5%; --dur: 140s; animation-delay: -115s; }
	@keyframes xr-float {
		from { transform: translateX(0); }
		to { transform: translateX(calc(-1 * (100vw + 100%) - 240px)); }
	}

	.xr-bo {
		position: absolute;
		left: 20%;
		bottom: 6px;
	}

	.xr-post {
		position: absolute;
		right: 4%;
		bottom: -1.5%;
		width: clamp(200px, 38%, 300px);
	}
	.xr-post svg {
		display: block;
		width: 100%;
		height: auto;
	}

	/* The scene-wide hover lift is for single-illustration panels; a stage
	   full of independently moving layers must not jump as one. */
	.scene.scene-crossroads:hover svg {
		transform: none;
	}

	/* Prop ink. Day is the art's own black; night lifts to soot with a light
	   rim and NEVER inverts — board whites stay white either way. */
	.xr-ink { fill: #1a1512; }
	.xr-lit { fill: #ffffff; }

${armCss}

	:global(:root[data-theme="dark"]) .xr-stage {
		background: #141210;
	}
	:global(:root[data-theme="dark"]) .xr-plate {
		filter: invert(1) brightness(0.85);
	}
	:global(:root[data-theme="dark"]) .xr-post svg {
		filter: drop-shadow(0 0 1.5px rgba(245, 241, 234, 0.5));
	}
	:global(:root[data-theme="dark"]) .xr-ink {
		fill: #2a2320;
	}
	:global(:root[data-theme="dark"]) .xr-lit {
		fill: #f5f1ea;
	}

	@media (prefers-reduced-motion: reduce) {
		.xr-plate,
		.xr-cloud,
		.xr-arm1, .xr-arm2, .xr-arm3, .xr-arm4, .xr-arm5 {
			animation: none;
		}
	}
</style>
`;

const OUT = "/home/codex/.herdr/worktrees/hobo/worktree-silver-river-5c07/site/src/components/scenes/Crossroads.astro";
writeFileSync(OUT, astro);
console.log("wrote", OUT, (astro.length / 1024).toFixed(1) + "KB");
