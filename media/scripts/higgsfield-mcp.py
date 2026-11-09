# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Call the Higgsfield MCP server directly, without a restart.

`higgsfield-auth` mints a token and wires it into Claude Code's config, but
the MCP tools only appear after Claude Code restarts — which a session in the
middle of a job cannot do. The server speaks plain streamable HTTP, so this
speaks it back: initialize, then list or call tools with the stored token.

    uv run media/scripts/higgsfield-mcp.py list
    uv run media/scripts/higgsfield-mcp.py call <tool> '<json arguments>'
    uv run media/scripts/higgsfield-mcp.py call <tool> @arguments.json

The token is read from ~/.higgsfield/token.json (written by
`.claude/skills/higgsfield-auth/scripts/hf-auth.mjs login`) and is never
printed. Run `hf-auth.mjs ensure` first if it may have expired.
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

URL = "https://mcp.higgsfield.ai/mcp"
STORE = Path.home() / ".higgsfield" / "token.json"


def _token() -> str:
	if not STORE.exists():
		raise SystemExit("no Higgsfield token stored — run hf-auth.mjs login")
	return json.loads(STORE.read_text())["access_token"]


class Session:
	def __init__(self) -> None:
		self.id: str | None = None
		self.n = 0
		self._rpc("initialize", {
			"protocolVersion": "2025-03-26",
			"capabilities": {},
			"clientInfo": {"name": "hobo-media-scripts", "version": "1"},
		})
		self._rpc("notifications/initialized", None, notify=True)

	def _rpc(self, method: str, params: dict | None, notify: bool = False) -> dict:
		self.n += 1
		msg: dict = {"jsonrpc": "2.0", "method": method}
		if params is not None:
			msg["params"] = params
		if not notify:
			msg["id"] = self.n
		req = urllib.request.Request(URL, data=json.dumps(msg).encode(), method="POST")
		req.add_header("Authorization", f"Bearer {_token()}")
		req.add_header("Content-Type", "application/json")
		req.add_header("Accept", "application/json, text/event-stream")
		if self.id:
			req.add_header("Mcp-Session-Id", self.id)
		try:
			with urllib.request.urlopen(req, timeout=600) as res:
				self.id = res.headers.get("Mcp-Session-Id") or self.id
				raw = res.read().decode()
				ctype = res.headers.get("Content-Type", "")
		except urllib.error.HTTPError as err:
			raise SystemExit(f"{method} -> HTTP {err.code}: {err.read().decode(errors='replace')[:300]}") from None
		if notify or not raw.strip():
			return {}
		if "text/event-stream" in ctype:
			# The reply to our request is the last `data:` event carrying our id.
			for line in reversed(raw.splitlines()):
				if line.startswith("data:"):
					doc = json.loads(line[5:].strip())
					if doc.get("id") == self.n:
						break
			else:
				raise SystemExit(f"{method}: no reply in the event stream")
		else:
			doc = json.loads(raw)
		if "error" in doc:
			raise SystemExit(f"{method}: {json.dumps(doc['error'])[:400]}")
		return doc.get("result", {})

	def tools(self) -> list[dict]:
		return self._rpc("tools/list", {}).get("tools", [])

	def call(self, name: str, arguments: dict) -> dict:
		return self._rpc("tools/call", {"name": name, "arguments": arguments})


def main() -> None:
	if len(sys.argv) < 2 or sys.argv[1] not in {"list", "call"}:
		raise SystemExit(__doc__)
	session = Session()
	if sys.argv[1] == "list":
		for tool in session.tools():
			print(json.dumps({"name": tool["name"], "description": tool.get("description", "")[:300], "schema": tool.get("inputSchema")}))
		return
	arg = sys.argv[3] if len(sys.argv) > 3 else "{}"
	arguments = json.loads(Path(arg[1:]).read_text() if arg.startswith("@") else arg)
	print(json.dumps(session.call(sys.argv[2], arguments), indent=1))


if __name__ == "__main__":
	main()
