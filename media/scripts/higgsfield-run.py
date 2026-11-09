# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Submit image generations to the Higgsfield API and keep an auditable run.

The Higgsfield MCP connector needs an interactive OAuth login, which a cloud
session cannot complete. This talks to the public HTTP API instead, with the
key the environment already holds, so generation works anywhere the key does.

Everything a run produces lands in `media/runs/<run-id>/` — gitignored, per
AGENTS.md "Generated-art rules": the prompt and payload that were sent, the
provider's status document, and the raw image exactly as returned. Nothing is
cleaned, cropped or promoted here; that is `build-trail-art.py`'s job, and it
only happens after someone has looked at the raw output.

    HIGGSFIELD_API_KEY=<key-id>:<secret> \\
      uv run media/scripts/higgsfield-run.py media/scripts/jobs/<file>.json

A job file is `{"run": "<run-id>", "jobs": [{...}]}`, each job:

    name          output stem, unique within the run
    model         endpoint id, e.g. "xai/grok-imagine-image-2.0"
    prompt        the prompt, verbatim
    refs          optional local image paths, uploaded and passed as image_urls
    params        optional extra body fields (resolution, aspect_ratio, ...)

Jobs whose output already exists are skipped, so a run can be resumed or
extended by appending jobs and running the same file again. Pass `--estimate`
to price a file without submitting anything.

The key is read from the environment and never written to a run folder.
"""

from __future__ import annotations

import argparse
import concurrent.futures as futures
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
API = "https://api.higgsfield.ai"
TERMINAL = {"completed", "failed", "nsfw", "canceled"}


def _key() -> str:
	key = os.environ.get("HIGGSFIELD_API_KEY", "")
	if not key:
		raise SystemExit("HIGGSFIELD_API_KEY is not set; nothing was submitted")
	return key


def _call(method: str, url: str, body: dict | None = None, *, auth: bool = True) -> dict:
	data = json.dumps(body).encode() if body is not None else None
	req = urllib.request.Request(url, data=data, method=method)
	if auth:
		req.add_header("Authorization", f"Key {_key()}")
	if data is not None:
		req.add_header("Content-Type", "application/json")
	try:
		with urllib.request.urlopen(req, timeout=120) as res:
			return json.loads(res.read() or b"{}")
	except urllib.error.HTTPError as err:
		detail = err.read().decode(errors="replace")[:400]
		raise RuntimeError(f"{method} {url.replace(API, '')} -> {err.code}: {detail}") from None


_uploaded: dict[str, str] = {}


def upload(path: Path) -> str:
	"""Presigned upload; returns the public URL the model will fetch."""
	key = str(path.resolve())
	if key in _uploaded:
		return _uploaded[key]
	ctype = mimetypes.guess_type(path.name)[0] or "image/png"
	slot = _call("POST", f"{API}/files/generate-upload-url", {"content_type": ctype})
	put = urllib.request.Request(slot["upload_url"], data=path.read_bytes(), method="PUT")
	# Storage wants exactly the headers it signed — and not our credentials.
	for name, value in slot.get("upload_headers", {"Content-Type": ctype}).items():
		put.add_header(name, value)
	with urllib.request.urlopen(put, timeout=180):
		pass
	_uploaded[key] = slot["public_url"]
	return slot["public_url"]


def body_for(job: dict) -> dict:
	body = {"prompt": job["prompt"], **job.get("params", {})}
	refs = [ROOT / r for r in job.get("refs", [])]
	if refs:
		body["image_urls"] = [upload(r) for r in refs]
	return body


def run_job(job: dict, out_dir: Path) -> str:
	name = job["name"]
	done = sorted(out_dir.glob(f"{name}.*"))
	if any(p.suffix in {".png", ".jpg", ".jpeg", ".webp"} for p in done):
		return f"{name}: already present, skipped"

	body = body_for(job)
	record = {"name": name, "model": job["model"], "body": body, "refs": job.get("refs", [])}
	(out_dir / f"{name}.request.json").write_text(json.dumps(record, indent=2))

	sub = _call("POST", f"{API}/{job['model']}", body)
	rid = sub["request_id"]
	deadline = time.time() + 900
	status = sub
	while status.get("status") not in TERMINAL:
		if time.time() > deadline:
			raise RuntimeError(f"{name}: still {status.get('status')} after 15 minutes ({rid})")
		time.sleep(4)
		status = _call("GET", f"{API}/requests/{rid}/status")
	(out_dir / f"{name}.status.json").write_text(json.dumps(status, indent=2))
	if status["status"] != "completed":
		return f"{name}: {status['status']} — {status.get('error')}"

	saved = []
	for i, image in enumerate(status.get("images", [])):
		url = image["url"]
		ext = Path(url.split("?")[0]).suffix or ".png"
		stem = name if i == 0 else f"{name}-{i + 1}"
		with urllib.request.urlopen(url, timeout=180) as res:
			(out_dir / f"{stem}{ext}").write_bytes(res.read())
		saved.append(f"{stem}{ext}")
	return f"{name}: {', '.join(saved) or 'completed with no image'}"


def main() -> None:
	ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
	ap.add_argument("jobfile", type=Path)
	ap.add_argument("--estimate", action="store_true", help="price the jobs; submit nothing")
	ap.add_argument("--only", nargs="*", help="run just these job names")
	args = ap.parse_args()

	spec = json.loads(args.jobfile.read_text())
	jobs = [j for j in spec["jobs"] if not args.only or j["name"] in args.only]
	out_dir = ROOT / "media" / "runs" / spec["run"]
	out_dir.mkdir(parents=True, exist_ok=True)

	if args.estimate:
		total = 0.0
		for job in jobs:
			# Estimation prices the parameters; a placeholder stands in for refs
			# so nothing is uploaded just to ask what it would cost.
			body = {"prompt": job["prompt"], **job.get("params", {})}
			if job.get("refs"):
				body["image_urls"] = ["https://example.com/ref.png"] * len(job["refs"])
			est = _call("POST", f"{API}/estimate/{job['model']}", body)
			total += float(est["usd"])
			print(f"{job['name']}: ${est['usd']}")
		print(f"total: ${total:.3f} for {len(jobs)} jobs")
		return

	failed = False
	with futures.ThreadPoolExecutor(max_workers=6) as pool:
		pending = {pool.submit(run_job, job, out_dir): job["name"] for job in jobs}
		for fut in futures.as_completed(pending):
			try:
				print(fut.result(), flush=True)
			except Exception as err:  # noqa: BLE001 — one bad job must not sink the rest
				failed = True
				print(f"{pending[fut]}: ERROR {err}", flush=True)
	print(f"run folder: {out_dir.relative_to(ROOT)}")
	if failed:
		sys.exit(1)


if __name__ == "__main__":
	main()
