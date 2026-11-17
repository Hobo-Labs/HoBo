/**
 * Playable HoBo Yard (canvas).
 * Loads measured Bo sheets from /assets; drives zones from control-api projections.
 * Clip metadata from assets_index.json — no hard-coded frame sizes in draw paths.
 */

const params = new URLSearchParams(location.search);
const API = params.get("api") || "http://127.0.0.1:8790";
const ASSET_BASE = params.get("assets") || "/assets";
/** playwright-testing deterministic mode: ?test=1&seed=42 */
const TEST_MODE = params.has("test");
const TEST_SEED = Number(params.get("seed") || "42") || 42;

function mulberry32(seed) {
	let t = seed >>> 0;
	return () => {
		t += 0x6d2b79f5;
		let r = Math.imul(t ^ (t >>> 15), 1 | t);
		r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
		return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
	};
}
let rng = mulberry32(TEST_SEED);
if (TEST_MODE) {
	Math.random = () => rng();
}

/** @type {any} */
let assetIndex = null;
/** @type {Record<string, HTMLImageElement>} */
const images = {};
/** @type {any} */
let snap = null;
/** @type {any} */
let visual = null;

const canvas = /** @type {HTMLCanvasElement} */ (
	document.getElementById("yard")
);
const ctx = canvas.getContext("2d");
if (!ctx) throw new Error("2d context required");

// Layout mirrors packages/control-yard/src/layout.ts (single SoT values).
const LAYOUT = {
	width: 1280,
	height: 720,
	groundY: 620,
	zones: {
		platformRest: {
			id: "platformRest",
			label: "Platform Rest",
			x: 80,
			y: 480,
			width: 220,
			height: 160,
			anchorX: 190,
			anchorY: 600,
		},
		bootstrapDesk: {
			id: "bootstrapDesk",
			label: "Bootstrap Desk",
			x: 340,
			y: 420,
			width: 180,
			height: 140,
			anchorX: 430,
			anchorY: 540,
		},
		activeRailTrack: {
			id: "activeRailTrack",
			label: "Active Rail Track",
			x: 120,
			y: 300,
			width: 1040,
			height: 80,
			anchorX: 640,
			anchorY: 360,
		},
		connectionBay: {
			id: "connectionBay",
			label: "Connection Bay",
			x: 900,
			y: 420,
			width: 280,
			height: 200,
			anchorX: 1040,
			anchorY: 580,
		},
		policyBoard: {
			id: "policyBoard",
			label: "Policy Board",
			x: 560,
			y: 120,
			width: 320,
			height: 140,
			anchorX: 720,
			anchorY: 250,
		},
		costBooth: {
			id: "costBooth",
			label: "Cost Booth",
			x: 1000,
			y: 120,
			width: 200,
			height: 140,
			anchorX: 1100,
			anchorY: 250,
		},
		errorBunker: {
			id: "errorBunker",
			label: "Error Bunker",
			x: 40,
			y: 100,
			width: 200,
			height: 140,
			anchorX: 140,
			anchorY: 230,
		},
	},
	costMeter: { x: 1020, y: 170, width: 160, height: 18 },
	trafficEmitter: { x: 140, y: 330, width: 1000 },
};

const state = {
	bo: {
		x: LAYOUT.zones.platformRest.anchorX,
		y: LAYOUT.zones.platformRest.anchorY,
	},
	target: {
		x: LAYOUT.zones.platformRest.anchorX,
		y: LAYOUT.zones.platformRest.anchorY,
	},
	zone: "platformRest",
	animId: "bo.idle",
	frame: 0,
	frameAcc: 0,
	particles: Array.from({ length: 48 }, () => ({
		x: 0,
		y: 0,
		vx: 0,
		alive: false,
	})),
	speech: "",
	speechT: 0,
	selectedZone: null,
	openSheet: null,
	lastSeq: -1,
	ready: false,
	lastError: "",
};

const el = {
	status: document.getElementById("status"),
	seq: document.getElementById("seq"),
	occupy: document.getElementById("occupy"),
	rail: document.getElementById("rail"),
	conn: document.getElementById("conn"),
	sheet: document.getElementById("sheet"),
	sheetTitle: document.getElementById("sheet-title"),
	sheetDesc: document.getElementById("sheet-desc"),
	sheetForm: document.getElementById("sheet-form"),
	sheetStream: document.getElementById("sheet-stream"),
	sheetClose: document.getElementById("sheet-close"),
	sheetConfirm: document.getElementById("sheet-confirm"),
};

async function loadImage(path) {
	const img = new Image();
	img.src = `${ASSET_BASE}/${path}`;
	await img.decode();
	return img;
}

async function bootAssets() {
	const res = await fetch(`${ASSET_BASE}/assets_index.json`);
	assetIndex = await res.json();
	for (const sheet of Object.values(assetIndex.spritesheets)) {
		images[sheet.id] = await loadImage(sheet.path);
	}
	for (const img of Object.values(assetIndex.images)) {
		images[img.id] = await loadImage(img.path);
	}
	// site ink-on-paper parallax plates only (DESIGN.md: traced art, never generative glop)
	for (const optional of [
		"trail.png",
		"trail-front.png",
		"poles.png",
		"cloud-1.png",
	]) {
		try {
			images[optional] = await loadImage(optional);
		} catch {
			/* optional plates may be missing */
		}
	}
}

function resolveAnim(animationId) {
	const ref = assetIndex.animationIds[animationId];
	if (!ref) throw new Error(`unknown animation ${animationId}`);
	const sheet = assetIndex.spritesheets[ref.sheet];
	const anim = sheet.animations[ref.animation];
	let frames = anim.frames;
	if (frames === "all") {
		const n = anim.frameCount ?? sheet.columns * sheet.rows;
		frames = Array.from({ length: n }, (_, i) => i);
	}
	return { sheet, anim, frames };
}

function drawSheetFrame(sheetId, frameIndex, dx, dy, scale = 0.55) {
	const sheet = assetIndex.spritesheets[sheetId];
	const img = images[sheetId];
	if (!sheet || !img) return;
	const col = frameIndex % sheet.columns;
	const row = Math.floor(frameIndex / sheet.columns);
	const sx = sheet.margin + col * (sheet.frameWidth + sheet.spacing);
	const sy = sheet.margin + row * (sheet.frameHeight + sheet.spacing);
	const dw = sheet.frameWidth * scale;
	const dh = sheet.frameHeight * scale;
	// Pixel art: never bilinear-filter Bo (phaser-gamedev / pixel STOP rule).
	const prev = ctx.imageSmoothingEnabled;
	ctx.imageSmoothingEnabled = false;
	// origin feet-baseline (0.5, 1)
	ctx.drawImage(
		img,
		sx,
		sy,
		sheet.frameWidth,
		sheet.frameHeight,
		Math.round(dx - dw * 0.5),
		Math.round(dy - dh),
		Math.round(dw),
		Math.round(dh),
	);
	ctx.imageSmoothingEnabled = prev;
}

function zoneAt(x, y) {
	for (const z of Object.values(LAYOUT.zones)) {
		if (x >= z.x && x <= z.x + z.width && y >= z.y && y <= z.y + z.height)
			return z.id;
	}
	return null;
}

function mapConnectionVisual(status) {
	if (status === "active") return "authorized";
	if (status === "pending" || status === "needs-reauth") return "pending";
	if (status === "revoked" || status === "expired") return "revoked";
	return "closed";
}

function deriveVisual(s) {
	if (!s) return null;
	const occupyMode = s.occupyMode ?? "idle";
	let zone = state.selectedZone || "platformRest";
	if (!state.selectedZone) {
		if ((s.doctor?.hazards?.length ?? 0) > 2) zone = "errorBunker";
		else if (s.occupancy?.bootstrapActive) zone = "bootstrapDesk";
		else if (occupyMode === "occupying" && s.occupancy?.activeRailHash)
			zone = "activeRailTrack";
		else if ((s.connections || []).some((c) => c.status === "pending"))
			zone = "connectionBay";
		else zone = "platformRest";
	}
	// Reuse good site sheets only: idle (bounce/blink) + walk E/W. No invented work/error art.
	const boState =
		zone === "activeRailTrack" && occupyMode === "occupying"
			? "walking"
			: occupyMode === "occupying"
				? "occupying"
				: zone === "connectionBay"
					? "resolving"
					: "idle";
	const facing =
		zone === "connectionBay" || zone === "costBooth" ? "east" : "west";
	const animationId =
		boState === "walking"
			? facing === "east"
				? "bo.walk.east"
				: "bo.walk.west"
			: "bo.idle";
	const quotaLimit = s.metering?.quotaLimit || 1;
	const fill = Math.min(
		1,
		Math.max(0, (s.metering?.quotaUsed ?? 0) / quotaLimit),
	);
	return {
		zone,
		boState,
		facing,
		animationId,
		traffic: {
			rate: s.metering?.trafficRate ?? 0,
			active:
				(s.metering?.trafficRate ?? 0) > 0 &&
				Boolean(s.occupancy?.activeRailHash) &&
				occupyMode === "occupying",
		},
		cost: {
			fill,
			heat: fill,
			quotaUsed: s.metering?.quotaUsed ?? 0,
			quotaLimit: s.metering?.quotaLimit ?? 0,
			spendCapUsd: s.metering?.spendCapUsd ?? 0,
		},
		rails: s.rails ?? [],
		connections: (s.connections ?? []).map((c) => ({
			...c,
			visual: mapConnectionVisual(c.status),
		})),
		doctor: s.doctor ?? { hazards: [], bootstrapActive: false },
		bootstrapActive: Boolean(s.occupancy?.bootstrapActive),
		occupyMode,
	};
}

function sheetForZone(zone, s) {
	if (zone === "connectionBay") {
		const pending = (s?.connections ?? []).find((c) => c.status === "pending");
		if (pending) {
			return {
				kind: "connection.authorize",
				title: "Authorize Connection",
				description: `Authorize ${pending.alias ?? pending.id} — hobo connection authorize`,
				confirmOp: "connectionAuthorize",
				fields: [
					{
						name: "idOrAlias",
						label: "Connection",
						type: "readonly",
						value: pending.alias ?? pending.id,
					},
					{
						name: "status",
						label: "Status",
						type: "readonly",
						value: pending.status,
					},
				],
				stream: ["Loading connection projection…", "Preparing authorize card…"],
			};
		}
		return {
			kind: "connection.create",
			title: "Open Connection Bay",
			description: "Create Station-scoped Connection — hobo connection create",
			confirmOp: "connectionCreate",
			fields: [
				{ name: "provider", label: "Provider", type: "string", value: "asana" },
				{ name: "alias", label: "Alias (optional)", type: "string", value: "" },
				{
					name: "stationId",
					label: "Station",
					type: "readonly",
					value: s?.occupancy?.stationId ?? "station:local",
				},
			],
			stream: [
				"Resolving connector schema…",
				"Binding Station isolation…",
				"Rendering connection form…",
			],
		};
	}
	if (zone === "policyBoard") {
		const rails = s?.rails ?? [];
		return {
			kind: "rail.lifecycle",
			title: "Rail Policy Board",
			description: "Publish / approve / activate — hobo station rails *",
			confirmOp: "stationRailsActivate",
			fields: [
				{
					name: "hashOrId",
					label: "Rail",
					type: "select",
					value:
						rails.find((r) => !r.isBootstrap)?.contentHash ??
						rails[0]?.contentHash ??
						"",
					options: rails.map((r) => r.contentHash),
				},
			],
			stream: ["Folding rail catalog…", "Streaming lifecycle sheet…"],
		};
	}
	if (zone === "costBooth") {
		return {
			kind: "cost.plan",
			title: "Cost Booth",
			description: "Rail billingPolicy fare meter (projection-only)",
			confirmOp: "noop",
			fields: [
				{
					name: "quotaUsed",
					label: "Quota used",
					type: "readonly",
					value: String(s?.metering?.quotaUsed ?? 0),
				},
				{
					name: "quotaLimit",
					label: "Quota limit",
					type: "readonly",
					value: String(s?.metering?.quotaLimit ?? 0),
				},
				{
					name: "spendCap",
					label: "Spend cap",
					type: "readonly",
					value: String(s?.metering?.spendCapUsd ?? 0),
				},
			],
			stream: ["Reading metering projection…"],
		};
	}
	if (zone === "errorBunker") {
		const hazards = s?.doctor?.hazards ?? [];
		return {
			kind: "doctor.hazards",
			title: "Error Bunker",
			description: "Doctor / drift / hazards",
			confirmOp: "noop",
			fields: [
				{
					name: "hazards",
					label: "Hazards",
					type: "readonly",
					value: hazards.join(", ") || "(none)",
				},
				{
					name: "hint",
					label: "Hint",
					type: "readonly",
					value: s?.doctor?.hint ?? "",
				},
			],
			stream: ["Scanning doctor projection…"],
		};
	}
	if (zone === "bootstrapDesk") {
		return {
			kind: "bootstrap",
			title: "Bootstrap Desk",
			description: s?.occupancy?.bootstrapActive
				? "Bootstrap Rail active — activate a production rail"
				: "Bootstrap inactive",
			confirmOp: "noop",
			fields: [
				{
					name: "bootstrap",
					label: "bootstrapActive",
					type: "readonly",
					value: String(Boolean(s?.occupancy?.bootstrapActive)),
				},
				{
					name: "active",
					label: "activeRailHash",
					type: "readonly",
					value: s?.occupancy?.activeRailHash ?? "(none)",
				},
			],
			stream: ["Reading occupancy…"],
		};
	}
	return {
		kind: "inspect",
		title: LAYOUT.zones[zone]?.label ?? zone,
		description: "Inspect zone (projection-driven)",
		confirmOp: "noop",
		fields: [{ name: "zone", label: "Zone", type: "readonly", value: zone }],
		stream: ["…"],
	};
}

function openSheet(sheet) {
	state.openSheet = sheet;
	el.sheet.hidden = false;
	el.sheetTitle.textContent = sheet.title;
	el.sheetDesc.textContent = sheet.description;
	el.sheetForm.innerHTML = "";
	for (const f of sheet.fields) {
		const lab = document.createElement("label");
		lab.textContent = f.label;
		lab.htmlFor = `f-${f.name}`;
		el.sheetForm.appendChild(lab);
		if (f.type === "select") {
			const sel = document.createElement("select");
			sel.id = `f-${f.name}`;
			sel.name = f.name;
			for (const opt of f.options || []) {
				const o = document.createElement("option");
				o.value = opt;
				o.textContent = opt.slice(0, 24) + (opt.length > 24 ? "…" : "");
				if (opt === f.value) o.selected = true;
				sel.appendChild(o);
			}
			el.sheetForm.appendChild(sel);
		} else {
			const input = document.createElement("input");
			input.id = `f-${f.name}`;
			input.name = f.name;
			input.value = f.value ?? "";
			input.readOnly = f.type === "readonly";
			el.sheetForm.appendChild(input);
		}
	}
	el.sheetStream.textContent = "";
	let i = 0;
	const ticks = sheet.stream || [];
	const timer = setInterval(() => {
		if (i >= ticks.length) {
			clearInterval(timer);
			return;
		}
		el.sheetStream.textContent = ticks[i++];
	}, 180);
}

function closeSheet() {
	state.openSheet = null;
	state.selectedZone = null;
	el.sheet.hidden = true;
}

async function api(path, init) {
	const res = await fetch(`${API}${path}`, {
		...init,
		headers: { "content-type": "application/json", ...init?.headers },
	});
	const body = await res.json();
	if (!body.ok && res.status >= 400) {
		throw new Error(body.message || `API ${res.status}`);
	}
	return body;
}

async function refreshSnapshot() {
	try {
		const body = await api("/v1/yard/snapshot?stationId=station:local");
		if (body.ok) {
			snap = body.data;
			visual = deriveVisual(snap);
			if (visual) {
				const z = LAYOUT.zones[visual.zone];
				state.target = { x: z.anchorX, y: z.anchorY };
				state.zone = visual.zone;
				state.animId = visual.animationId;
			}
			el.status.textContent = "live";
			el.seq.textContent = `seq=${snap.seq}`;
			el.occupy.textContent = `occupy=${snap.occupyMode}`;
			el.rail.textContent = `rail=${(snap.occupancy?.activeRailHash || "none").slice(0, 18)}`;
			el.conn.textContent = `conn=${(snap.connections || []).length} traffic=${(snap.metering?.trafficRate ?? 0).toFixed(2)}`;
			state.lastError = "";
			document.body.dataset.yardReady = "1";
			document.body.dataset.boAnim = state.animId;
			document.body.dataset.zone = state.zone;
			document.body.dataset.connCount = String((snap.connections || []).length);
			document.body.dataset.traffic = String(snap.metering?.trafficRate ?? 0);
			document.body.dataset.bootstrap = String(
				Boolean(snap.occupancy?.bootstrapActive),
			);
		} else {
			el.status.textContent = body.message || "no snapshot";
			state.lastError = body.message || "no snapshot";
		}
	} catch (err) {
		el.status.textContent = `api error: ${err.message}`;
		state.lastError = String(err.message || err);
	}
}

async function runAction(action) {
	const stationId = "station:local";
	try {
		if (action === "init") {
			await api("/v1/station/init", {
				method: "POST",
				body: JSON.stringify({ name: "local", tenant: "local" }),
			});
			state.speech = "Station open.";
		} else if (action === "up") {
			await api("/v1/station/up", {
				method: "POST",
				body: JSON.stringify({ stationId }),
			});
			state.speech = "Occupying.";
		} else if (action === "down") {
			await api("/v1/station/down", {
				method: "POST",
				body: JSON.stringify({ stationId }),
			});
			state.speech = "Idle.";
		} else if (action === "publish-rail") {
			await api("/v1/station/rails/publish", {
				method: "POST",
				body: JSON.stringify({
					stationId,
					id: "rail-prod",
					name: "prod",
					version: "1.0.0",
				}),
			});
			state.speech = "Rail draft.";
		} else if (action === "activate-rail") {
			const list = await api(`/v1/station/rails?stationId=${stationId}`);
			const rails = list.data?.rails || [];
			const rail = rails.find((r) => !r.isBootstrap) || rails[0];
			if (!rail) throw new Error("no rail");
			await api("/v1/station/rails/approve", {
				method: "POST",
				body: JSON.stringify({ stationId, hashOrId: rail.contentHash }),
			});
			await api("/v1/station/rails/activate", {
				method: "POST",
				body: JSON.stringify({ stationId, hashOrId: rail.contentHash }),
			});
			state.speech = "Rail active.";
		} else if (action === "create-conn") {
			await api("/v1/connection/create", {
				method: "POST",
				body: JSON.stringify({
					provider: "asana",
					alias: "work",
					stationId,
				}),
			});
			state.speech = "Connection pending.";
			state.selectedZone = "connectionBay";
		} else if (action === "authorize-conn") {
			await api("/v1/connection/authorize", {
				method: "POST",
				body: JSON.stringify({ idOrAlias: "work" }),
			});
			state.speech = "Connection active.";
		}
		state.speechT = 2.5;
		await refreshSnapshot();
	} catch (err) {
		state.speech = String(err.message || err);
		state.speechT = 3;
		el.status.textContent = state.speech;
	}
}

async function confirmSheet() {
	const sheet = state.openSheet;
	if (!sheet) return;
	const values = {};
	for (const elInput of el.sheetForm.querySelectorAll("input,select")) {
		values[elInput.name] = elInput.value;
	}
	try {
		if (sheet.confirmOp === "connectionCreate") {
			await api("/v1/connection/create", {
				method: "POST",
				body: JSON.stringify({
					provider: values.provider,
					alias: values.alias || undefined,
					stationId: values.stationId || "station:local",
				}),
			});
			state.speech = "Created.";
		} else if (sheet.confirmOp === "connectionAuthorize") {
			await api("/v1/connection/authorize", {
				method: "POST",
				body: JSON.stringify({ idOrAlias: values.idOrAlias }),
			});
			state.speech = "Authorized.";
		} else if (sheet.confirmOp === "stationRailsActivate") {
			await api("/v1/station/rails/approve", {
				method: "POST",
				body: JSON.stringify({
					stationId: "station:local",
					hashOrId: values.hashOrId,
				}),
			});
			await api("/v1/station/rails/activate", {
				method: "POST",
				body: JSON.stringify({
					stationId: "station:local",
					hashOrId: values.hashOrId,
				}),
			});
			state.speech = "Rail activated.";
		} else {
			state.speech = "Noted.";
		}
		state.speechT = 2;
		closeSheet();
		await refreshSnapshot();
	} catch (err) {
		el.sheetStream.textContent = String(err.message || err);
	}
}

function drawBackground() {
	// DESIGN.md: ink on paper — pure paper ground, no SaaS sky gradients
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, LAYOUT.width, LAYOUT.height);

	// faint horizon rule
	ctx.strokeStyle = "#e3e2de";
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.moveTo(0, 200);
	ctx.lineTo(LAYOUT.width, 200);
	ctx.stroke();

	const prevSmooth = ctx.imageSmoothingEnabled;
	ctx.imageSmoothingEnabled = false;

	// distant poles (rim silhouettes — site plate)
	if (images["poles.png"]) {
		ctx.globalAlpha = 0.55;
		ctx.drawImage(images["poles.png"], 0, 80, LAYOUT.width, 320);
		ctx.globalAlpha = 1;
	}

	// trail band behind Bo (ink line-art plate)
	if (images["trail.png"]) {
		ctx.globalAlpha = 1;
		ctx.drawImage(
			images["trail.png"],
			0,
			LAYOUT.groundY - 280,
			LAYOUT.width,
			320,
		);
	}

	// paper ground strip under feet
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(
		0,
		LAYOUT.groundY - 8,
		LAYOUT.width,
		LAYOUT.height - LAYOUT.groundY + 8,
	);
	ctx.strokeStyle = "#101010";
	ctx.lineWidth = 2;
	ctx.beginPath();
	ctx.moveTo(0, LAYOUT.groundY);
	ctx.lineTo(LAYOUT.width, LAYOUT.groundY);
	ctx.stroke();

	// clouds keep white (DESIGN.md: clouds are keep, not invert)
	if (images["cloud-1.png"]) {
		ctx.drawImage(images["cloud-1.png"], 60, 24, 200, 80);
		ctx.drawImage(images["cloud-1.png"], 920, 40, 240, 90);
	}

	ctx.imageSmoothingEnabled = prevSmooth;
}

/** Near bank plate draws after Bo so he stands on the trail. */
function drawTrailFront() {
	if (!images["trail-front.png"]) return;
	const prevSmooth = ctx.imageSmoothingEnabled;
	ctx.imageSmoothingEnabled = false;
	ctx.globalAlpha = 0.95;
	ctx.drawImage(
		images["trail-front.png"],
		0,
		LAYOUT.groundY - 100,
		LAYOUT.width,
		140,
	);
	ctx.globalAlpha = 1;
	ctx.imageSmoothingEnabled = prevSmooth;
}

function drawZone(z, opts = {}) {
	const active = opts.active;
	const hot = opts.hot;
	ctx.save();
	// sticker card: paper fill, thick ink rim, hard offset shadow
	ctx.fillStyle = "rgba(16,16,16,0.12)";
	ctx.fillRect(z.x + 3, z.y + 3, z.width, z.height);
	ctx.fillStyle = hot ? "#f2f1ec" : "#ffffff";
	ctx.fillRect(z.x, z.y, z.width, z.height);
	ctx.strokeStyle = "#101010";
	ctx.lineWidth = active || hot ? 3 : 2;
	ctx.strokeRect(z.x + 0.5, z.y + 0.5, z.width - 1, z.height - 1);
	if (active) {
		// inner rail
		ctx.strokeStyle = "#101010";
		ctx.lineWidth = 1;
		ctx.strokeRect(z.x + 4.5, z.y + 4.5, z.width - 9, z.height - 9);
	}
	ctx.fillStyle = "#101010";
	ctx.font = "700 11px system-ui, sans-serif";
	ctx.fillText(z.label, z.x + 10, z.y + 18);
	ctx.restore();
}

function drawRailTrack(v) {
	const z = LAYOUT.zones.activeRailTrack;
	const lit =
		Boolean(snap?.occupancy?.activeRailHash) &&
		snap?.occupyMode === "occupying";
	// ink ties on paper — no yellow SaaS glow
	ctx.fillStyle = lit ? "#101010" : "#4a4a46";
	ctx.fillRect(z.x, z.y + 20, z.width, 28);
	ctx.strokeStyle = lit ? "#101010" : "#6e6d68";
	ctx.lineWidth = 2;
	for (let x = z.x + 10; x < z.x + z.width; x += 36) {
		ctx.beginPath();
		ctx.moveTo(x, z.y + 18);
		ctx.lineTo(x + 16, z.y + 50);
		ctx.stroke();
	}
	if (lit) {
		// paper highlight dashes on active rail
		ctx.strokeStyle = "#ffffff";
		ctx.lineWidth = 2;
		ctx.setLineDash([10, 10]);
		ctx.beginPath();
		ctx.moveTo(z.x + 8, z.y + 34);
		ctx.lineTo(z.x + z.width - 8, z.y + 34);
		ctx.stroke();
		ctx.setLineDash([]);
	}
	// rail plaques
	const rails = v?.rails || [];
	rails.slice(0, 5).forEach((r, i) => {
		const px = LAYOUT.zones.policyBoard.x + 16 + i * 60;
		const py = LAYOUT.zones.policyBoard.y + 40;
		// ink/paper plaques — go for active, ink for draft/approved, no SaaS blue
		const color =
			r.activationStatus === "active"
				? "#14672c"
				: r.activationStatus === "approved"
					? "#101010"
					: r.activationStatus === "draft"
						? "#4a4a46"
						: "#6e6d68";
		ctx.fillStyle = color;
		ctx.fillRect(px, py, 48, 28);
		ctx.strokeStyle = "#101010";
		ctx.lineWidth = 2;
		ctx.strokeRect(px, py, 48, 28);
		ctx.fillStyle = "#ffffff";
		ctx.font = "700 9px system-ui, sans-serif";
		ctx.fillText(r.activationStatus.slice(0, 6), px + 4, py + 18);
	});
}

function drawConnectionBays(v) {
	const z = LAYOUT.zones.connectionBay;
	const conns = v?.connections || [];
	const slots = Math.max(3, conns.length);
	for (let i = 0; i < slots; i++) {
		const c = conns[i];
		const bx = z.x + 24 + (i % 3) * 80;
		const by = z.y + 40 + Math.floor(i / 3) * 70;
		const visual = c?.visual || "closed";
		// ink/paper status: go/spark accents only (DESIGN.md)
		const fill =
			visual === "authorized"
				? "#14672c"
				: visual === "pending"
					? "#101010"
					: visual === "revoked"
						? "#c5301c"
						: "#444";
		ctx.fillStyle = fill;
		ctx.fillRect(bx, by, 56, 48);
		ctx.strokeStyle = "#111";
		ctx.lineWidth = 2;
		ctx.strokeRect(bx, by, 56, 48);
		// door split
		ctx.beginPath();
		ctx.moveTo(bx + 28, by);
		ctx.lineTo(bx + 28, by + 48);
		ctx.stroke();
		if (images["connection-bay"]) {
			ctx.drawImage(images["connection-bay"], bx + 12, by + 8, 32, 32);
		}
		if (c) {
			ctx.fillStyle = "#fff";
			ctx.font = "9px monospace";
			ctx.fillText((c.alias || c.provider || "?").slice(0, 7), bx + 4, by + 44);
		}
	}
}

function drawCostMeter(v) {
	const m = LAYOUT.costMeter;
	const fill = v?.cost?.fill ?? 0;
	const heat = v?.cost?.heat ?? 0;
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(m.x, m.y, m.width, m.height);
	ctx.strokeStyle = "#101010";
	ctx.lineWidth = 2;
	ctx.strokeRect(m.x, m.y, m.width, m.height);
	ctx.fillStyle = heat > 0.8 ? "#c5301c" : "#14672c";
	ctx.fillRect(m.x + 2, m.y + 2, (m.width - 4) * fill, m.height - 4);
	ctx.fillStyle = "#101010";
	ctx.font = "700 11px system-ui, sans-serif";
	ctx.fillText(`fare ${(fill * 100).toFixed(0)}%`, m.x, m.y - 6);
}

function drawErrorBunker(v) {
	const z = LAYOUT.zones.errorBunker;
	const active = (v?.doctor?.hazards?.length ?? 0) > 0;
	if (active) {
		ctx.fillStyle = "rgba(120,20,20,0.25)";
		ctx.fillRect(z.x, z.y, z.width, z.height);
		ctx.fillStyle = "#6b1d1d";
		ctx.font = "11px monospace";
		const hazards = v.doctor.hazards.slice(0, 3);
		for (const [i, h] of hazards.entries()) {
			ctx.fillText(h.slice(0, 22), z.x + 8, z.y + 40 + i * 14);
		}
	}
}

function drawBootstrap(v) {
	const z = LAYOUT.zones.bootstrapDesk;
	if (v?.bootstrapActive) {
		ctx.fillStyle = "#6a5a20";
		ctx.font = "11px monospace";
		ctx.fillText("⚠ bootstrap rail", z.x + 12, z.y + 48);
	}
}

function drawParticles(dt) {
	// playwright-testing: disable particles in test mode for stable screenshots
	if (TEST_MODE) return;
	const rate = visual?.traffic?.active ? visual.traffic.rate : 0;
	// Keep a few cars visible even at modest rates so the yard reads "alive".
	let budget = Math.max(rate > 0 ? 2 * dt : 0, rate * 14 * dt);
	const em = LAYOUT.trafficEmitter;
	for (const p of state.particles) {
		if (p.alive) {
			p.x += p.vx * dt;
			if (p.x > em.x + em.width) p.alive = false;
		} else if (budget >= 1) {
			p.alive = true;
			p.x = em.x + Math.random() * 40;
			p.y = em.y + (Math.random() * 36 - 18);
			p.vx = 90 + rate * 140;
			budget -= 1;
		}
		if (p.alive) {
			// larger cargo boxes on the lit track
			ctx.fillStyle = "#111";
			ctx.fillRect(p.x, p.y, 12, 10);
			ctx.fillStyle = "#fff";
			ctx.fillRect(p.x + 2, p.y + 2, 8, 6);
			ctx.fillStyle = "#111";
			ctx.fillRect(p.x + 3, p.y + 3, 6, 4);
		}
	}
}

function drawBo(dt) {
	// move toward target
	const speed = 180;
	const dx = state.target.x - state.bo.x;
	const dy = state.target.y - state.bo.y;
	const dist = Math.hypot(dx, dy);
	const step = speed * dt;
	if (dist > step) {
		state.bo.x += (dx / dist) * step;
		state.bo.y += (dy / dist) * step;
		// prefer walk anim while moving
		if (Math.abs(dx) >= Math.abs(dy)) {
			state.animId = dx >= 0 ? "bo.walk.east" : "bo.walk.west";
		}
	} else {
		state.bo.x = state.target.x;
		state.bo.y = state.target.y;
		if (visual) state.animId = visual.animationId;
	}

	const { sheet, frames, anim } = resolveAnim(state.animId);
	if (!TEST_MODE) {
		const frameMs = sheet.frameMs ?? 1000 / (anim.frameRate || 8);
		state.frameAcc += dt * 1000;
		while (state.frameAcc >= frameMs) {
			state.frameAcc -= frameMs;
			state.frame = (state.frame + 1) % frames.length;
		}
	} else {
		// freeze on first frame for deterministic screenshots
		state.frame = 0;
	}
	const frameIndex = frames[state.frame] ?? 0;
	// never mirror west — use dedicated sheet
	drawSheetFrame(
		sheet.id,
		frameIndex,
		state.bo.x,
		state.bo.y,
		state.animId.includes("walk") ? 0.7 : 0.55,
	);

	if (state.speechT > 0) {
		state.speechT -= dt;
		const text = state.speech;
		ctx.font = "12px monospace";
		const w = Math.min(220, ctx.measureText(text).width + 16);
		const bx = state.bo.x - w / 2;
		const by = state.bo.y - (state.animId.includes("walk") ? 130 : 150);
		ctx.fillStyle = "#fffdf7";
		ctx.strokeStyle = "#111";
		ctx.lineWidth = 1.5;
		ctx.fillRect(bx, by, w, 24);
		ctx.strokeRect(bx, by, w, 24);
		ctx.fillStyle = "#111";
		ctx.fillText(text, bx + 8, by + 16);
	}

	document.body.dataset.boX = String(Math.round(state.bo.x));
	document.body.dataset.boY = String(Math.round(state.bo.y));
	document.body.dataset.boAnim = state.animId;
}

function drawHudOverlay() {
	// sticker caption card
	ctx.fillStyle = "rgba(16,16,16,0.12)";
	ctx.fillRect(19, 19, 300, 52);
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(16, 16, 300, 52);
	ctx.strokeStyle = "#101010";
	ctx.lineWidth = 2;
	ctx.strokeRect(16.5, 16.5, 299, 51);
	ctx.fillStyle = "#101010";
	ctx.font = "700 12px system-ui, sans-serif";
	ctx.fillText("HoBo Yard · single Station", 26, 36);
	ctx.fillStyle = "#4a4a46";
	ctx.font = "11px ui-monospace, monospace";
	ctx.fillText(`zone=${state.zone} anim=${state.animId}`, 26, 54);
}

let last = performance.now();
let frameCount = 0;
/** Fixed dt in test mode for deterministic movement. */
const FIXED_DT = 1 / 60;

function frame(now) {
	const dt = TEST_MODE ? FIXED_DT : Math.min(0.05, (now - last) / 1000);
	last = now;
	frameCount += 1;
	if (window.__TEST__) {
		window.__TEST__.frameCount = frameCount;
	}
	drawBackground();
	for (const z of Object.values(LAYOUT.zones)) {
		drawZone(z, {
			active: state.zone === z.id,
			hot: state.selectedZone === z.id,
		});
	}
	drawRailTrack(visual);
	drawConnectionBays(visual);
	drawCostMeter(visual);
	drawErrorBunker(visual);
	drawBootstrap(visual);
	drawParticles(dt);
	// guest agents near bay
	if (
		visual?.connections?.some((c) => c.visual === "authorized") &&
		images["guest-swe-claude"]
	) {
		const g = assetIndex.spritesheets["guest-swe-claude"];
		const guestFrame = TEST_MODE ? 0 : Math.floor(now / 120) % 4;
		const sx = (4 + (guestFrame % 4)) * g.frameWidth; // work frames
		ctx.drawImage(
			images["guest-swe-claude"],
			sx,
			0,
			g.frameWidth,
			g.frameHeight,
			LAYOUT.zones.connectionBay.x + 30,
			LAYOUT.zones.connectionBay.anchorY - 48,
			48,
			48,
		);
	}
	if (state.ready) drawBo(dt);
	drawTrailFront();
	drawHudOverlay();
	if (window.__TEST__ && !window.__TEST__.ready && state.ready && snap) {
		// first interactive frame after assets + projection
		if (frameCount >= 2) {
			window.__TEST__.ready = true;
			document.body.dataset.testReady = "1";
		}
	}
	requestAnimationFrame(frame);
}

// input
canvas.addEventListener("click", (ev) => {
	const rect = canvas.getBoundingClientRect();
	const scaleX = canvas.width / rect.width;
	const scaleY = canvas.height / rect.height;
	const x = (ev.clientX - rect.left) * scaleX;
	const y = (ev.clientY - rect.top) * scaleY;
	const zone = zoneAt(x, y);
	if (!zone) return;
	state.selectedZone = zone;
	const z = LAYOUT.zones[zone];
	state.target = { x: z.anchorX, y: z.anchorY };
	state.zone = zone;
	state.speech = z.label;
	state.speechT = 1.5;
	openSheet(sheetForZone(zone, snap));
	document.body.dataset.lastClickZone = zone;
});

el.sheetClose.addEventListener("click", closeSheet);
el.sheetConfirm.addEventListener("click", () => void confirmSheet());
document.querySelectorAll("#actions button").forEach((btn) => {
	btn.addEventListener(
		"click",
		() => void runAction(btn.getAttribute("data-action")),
	);
});

function selectZoneById(zone) {
	const z = LAYOUT.zones[zone];
	if (!z) return;
	state.selectedZone = zone;
	state.target = { x: z.anchorX, y: z.anchorY };
	state.zone = zone;
	state.speech = z.label;
	state.speechT = TEST_MODE ? 0 : 1.5;
	openSheet(sheetForZone(zone, snap));
	document.body.dataset.lastClickZone = zone;
}

// Walking uses a directional sheet; idle retains the projected/default facing
// for compatibility, with its source made explicit in the test evidence.
function boDirection() {
	const projectedFacing = visual?.facing ?? null;
	const renderedFacing =
		state.animId === "bo.walk.east"
			? "east"
			: state.animId === "bo.walk.west"
				? "west"
				: null;
	return {
		facing: renderedFacing ?? projectedFacing ?? "east",
		facingSource: renderedFacing
			? "rendered-walk"
			: projectedFacing
				? "projected"
				: "default",
		projectedFacing,
	};
}

// playwright-testing seam (stable, serializable — no engine objects)
window.__TEST__ = {
	ready: false,
	seed: TEST_MODE ? TEST_SEED : null,
	sceneKey: "Yard",
	frameCount: 0,
	state: () => ({
		scene: "Yard",
		ready: window.__TEST__.ready,
		seed: window.__TEST__.seed,
		frameCount: window.__TEST__.frameCount,
		zone: state.zone,
		bo: {
			x: Math.round(state.bo.x),
			y: Math.round(state.bo.y),
			animationId: state.animId,
			...boDirection(),
		},
		occupyMode: snap?.occupyMode ?? null,
		connCount: snap?.connections?.length ?? 0,
		trafficRate: snap?.metering?.trafficRate ?? 0,
		bootstrapActive: Boolean(snap?.occupancy?.bootstrapActive),
		sheetOpen: Boolean(state.openSheet),
		sheetKind: state.openSheet?.kind ?? null,
		seq: snap?.seq ?? null,
		hazards: [...(snap?.doctor?.hazards ?? [])],
	}),
	commands: {
		reset: () => {
			state.bo = {
				x: LAYOUT.zones.platformRest.anchorX,
				y: LAYOUT.zones.platformRest.anchorY,
			};
			state.target = { ...state.bo };
			state.zone = "platformRest";
			state.selectedZone = null;
			state.animId = "bo.idle";
			closeSheet();
			rng = mulberry32(TEST_SEED);
			if (TEST_MODE) Math.random = () => rng();
		},
		seed: (n) => {
			window.__TEST__.seed = n;
			rng = mulberry32(n);
			if (TEST_MODE) Math.random = () => rng();
		},
		selectZone: (zone) => selectZoneById(zone),
		dismissSheet: () => closeSheet(),
		runAction: (action) => runAction(action),
		advanceFrame: (dtMs = 16.67) => {
			// force one logic tick without waiting for rAF
			const dt = dtMs / 1000;
			frameCount += 1;
			window.__TEST__.frameCount = frameCount;
			if (state.ready) {
				// only advance bo position (draw still via rAF)
				const speed = 180;
				const dx = state.target.x - state.bo.x;
				const dy = state.target.y - state.bo.y;
				const dist = Math.hypot(dx, dy);
				const step = speed * dt;
				if (dist > step) {
					state.bo.x += (dx / dist) * step;
					state.bo.y += (dy / dist) * step;
				} else {
					state.bo.x = state.target.x;
					state.bo.y = state.target.y;
				}
			}
		},
	},
};

// boot
(async () => {
	try {
		await bootAssets();
		state.ready = true;
		document.body.dataset.assetsReady = "1";
		el.status.textContent = "assets ready · contacting API…";
		await refreshSnapshot();
		// if no station, auto-init for demo friendliness (skip in pure test when API pre-seeded)
		if (!TEST_MODE && (state.lastError || !snap)) {
			try {
				await runAction("init");
				await runAction("up");
			} catch {
				/* ignore */
			}
		}
		// quieter polling in test mode
		setInterval(() => void refreshSnapshot(), TEST_MODE ? 2000 : 800);
		requestAnimationFrame(frame);
	} catch (err) {
		el.status.textContent = `boot failed: ${err.message || err}`;
		console.error(err);
	}
})();

// legacy alias
window.__HOBO_YARD__ = {
	get state() {
		return state;
	},
	get snap() {
		return snap;
	},
	get visual() {
		return visual;
	},
	refreshSnapshot,
	runAction,
	closeSheet,
	API,
	TEST_MODE,
};
