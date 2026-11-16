/**
 * Animation isolation harness (phaser-gamedev AnimTestScene pattern).
 * Loads frames only via assets_index.json measured metadata.
 */
const ASSET_BASE = "/assets";
const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
const label = document.getElementById("label");

let index = null;
const images = {};
let animId = "bo.idle";
let frame = 0;
let acc = 0;
let last = performance.now();

async function loadImage(path) {
	const img = new Image();
	img.src = `${ASSET_BASE}/${path}`;
	await img.decode();
	return img;
}

function resolve(animId) {
	const ref = index.animationIds[animId];
	const sheet = index.spritesheets[ref.sheet];
	const anim = sheet.animations[ref.animation];
	let frames = anim.frames;
	if (frames === "all") {
		const n = anim.frameCount ?? sheet.columns * sheet.rows;
		frames = Array.from({ length: n }, (_, i) => i);
	}
	return { sheet, anim, frames };
}

function draw(now) {
	const dt = Math.min(0.05, (now - last) / 1000);
	last = now;
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	// checkerboard to verify transparency
	for (let y = 0; y < canvas.height; y += 16) {
		for (let x = 0; x < canvas.width; x += 16) {
			ctx.fillStyle = (x / 16 + y / 16) % 2 === 0 ? "#2a3a2a" : "#1e2a1e";
			ctx.fillRect(x, y, 16, 16);
		}
	}
	if (!index) {
		requestAnimationFrame(draw);
		return;
	}
	const { sheet, anim, frames } = resolve(animId);
	const frameMs = sheet.frameMs ?? 1000 / (anim.frameRate || anim.fps || 8);
	acc += dt * 1000;
	while (acc >= frameMs) {
		acc -= frameMs;
		frame = (frame + 1) % frames.length;
	}
	const fi = frames[frame];
	const col = fi % sheet.columns;
	const row = Math.floor(fi / sheet.columns);
	const sx = sheet.margin + col * (sheet.frameWidth + sheet.spacing);
	const sy = sheet.margin + row * (sheet.frameHeight + sheet.spacing);
	const img = images[sheet.id];
	const scale = animId.includes("guest") ? 3 : 1.6;
	const dw = sheet.frameWidth * scale;
	const dh = sheet.frameHeight * scale;
	const cx = canvas.width / 2;
	const cy = canvas.height / 2 + 40;
	ctx.imageSmoothingEnabled = false;
	ctx.drawImage(
		img,
		sx,
		sy,
		sheet.frameWidth,
		sheet.frameHeight,
		cx - dw / 2,
		cy - dh,
		dw,
		dh,
	);
	// baseline
	ctx.strokeStyle = "#f5e6a6";
	ctx.beginPath();
	ctx.moveTo(cx - 80, cy);
	ctx.lineTo(cx + 80, cy);
	ctx.stroke();
	label.textContent = `${animId} | ${sheet.frameWidth}x${sheet.frameHeight} | frame ${fi}/${frames.length - 1} | ${sheet.path}`;
	window.__TEST__.frameCount += 1;
	window.__TEST__.animId = animId;
	window.__TEST__.frameIndex = fi;
	requestAnimationFrame(draw);
}

window.__TEST__ = {
	ready: false,
	animId: "bo.idle",
	frameIndex: 0,
	frameCount: 0,
	state: () => ({
		ready: window.__TEST__.ready,
		animId: window.__TEST__.animId,
		frameIndex: window.__TEST__.frameIndex,
		frameCount: window.__TEST__.frameCount,
	}),
	commands: {
		showAnim: (id) => {
			animId = id;
			frame = 0;
			acc = 0;
			window.__TEST__.animId = id;
		},
	},
};

(async () => {
	index = await (await fetch(`${ASSET_BASE}/assets_index.json`)).json();
	for (const sheet of Object.values(index.spritesheets)) {
		images[sheet.id] = await loadImage(sheet.path);
	}
	window.__TEST__.ready = true;
	document.body.dataset.animReady = "1";
	document.querySelectorAll("button[data-anim]").forEach((btn) => {
		btn.addEventListener("click", () => {
			window.__TEST__.commands.showAnim(btn.getAttribute("data-anim"));
		});
	});
	window.addEventListener("keydown", (e) => {
		const ids = Object.keys(index.animationIds);
		const i = ids.indexOf(animId);
		if (e.key === "ArrowRight")
			window.__TEST__.commands.showAnim(ids[(i + 1) % ids.length]);
		if (e.key === "ArrowLeft")
			window.__TEST__.commands.showAnim(ids[(i - 1 + ids.length) % ids.length]);
	});
	requestAnimationFrame(draw);
})();
