/**
 * Extract spritesheet frames to PNG sequences for gamedev-assets make_gifs.
 * Measure-first: frame sizes come from assets_index.json only.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Use sharp if available, else pure zlib PNG decode is hard — use child uv+pillow
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = join(ROOT, "assets");
const OUT = join(ROOT, "tmp", "frames");

const _index = JSON.parse(
	readFileSync(join(ASSETS, "assets_index.json"), "utf8"),
) as {
	spritesheets: Record<
		string,
		{
			path: string;
			frameWidth: number;
			frameHeight: number;
			columns: number;
			rows: number;
			margin: number;
			spacing: number;
			animations: Record<
				string,
				{ frames: number[] | "all"; frameCount?: number }
			>;
		}
	>;
};

const py = `
from pathlib import Path
from PIL import Image
import json, sys

assets = Path(sys.argv[1])
out = Path(sys.argv[2])
index = json.loads(Path(sys.argv[3]).read_text())
out.mkdir(parents=True, exist_ok=True)

for sheet_id, sheet in index["spritesheets"].items():
    img = Image.open(assets / sheet["path"]).convert("RGBA")
    fw, fh = sheet["frameWidth"], sheet["frameHeight"]
    cols, rows = sheet["columns"], sheet["rows"]
    margin = sheet.get("margin", 0)
    spacing = sheet.get("spacing", 0)
    for anim_name, anim in sheet["animations"].items():
        frames = anim["frames"]
        if frames == "all":
            n = anim.get("frameCount") or cols * rows
            frames = list(range(n))
        dest = out / f"{sheet_id}_{anim_name}"
        dest.mkdir(parents=True, exist_ok=True)
        for i, fi in enumerate(frames):
            col = fi % cols
            row = fi // cols
            sx = margin + col * (fw + spacing)
            sy = margin + row * (fh + spacing)
            cell = img.crop((sx, sy, sx + fw, sy + fh))
            cell.save(dest / f"step{i:03d}.png")
        print(f"wrote {dest} ({len(frames)} frames)")
`;

import { spawnSync } from "node:child_process";

const pyPath = join(ROOT, "tmp", "_extract_frames.py");
mkdirSync(dirname(pyPath), { recursive: true });
writeFileSync(pyPath, py);
const r = spawnSync(
	"uv",
	[
		"run",
		"--with",
		"pillow",
		"python",
		pyPath,
		ASSETS,
		OUT,
		join(ASSETS, "assets_index.json"),
	],
	{ encoding: "utf8" },
);
process.stdout.write(r.stdout || "");
process.stderr.write(r.stderr || "");
if (r.status !== 0) process.exit(r.status ?? 1);
