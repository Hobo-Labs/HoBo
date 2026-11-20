# ux experience proofs

End-user experience. Artifacts: `assets/` with REAL visuals — SVG/PNG wireframes, image mockups, screenshots. TypeScript "mockup modules" do not satisfy the gate.

## Interactive / game UX evidence (mandatory when applicable)

For proofs that claim a **playable UI, canvas game, or interactive control surface**:

1. **Screenshots alone are not enough** when motion or multi-step interaction is claimed.
2. Capture **Playwright screenshots and MP4 recordings** as feature evidence.
3. Store them under the proof’s `assets/evidence/` (or the owning package’s
   `public/shots/` with a sync step into the proof).
4. Ship an **`evidence-manifest.json`** listing each file’s path, byte size, and
   sha256. Zero-byte or missing files fail review.
5. Agents must **open/read** the PNGs (and MP4 keyframes via ffmpeg if needed)
   before claiming visual acceptance. Self-report without files is rejected.

Everything else (proof.json, executed examples/, notebook, cascade rule, run commands) follows the
parent [`src/draft/exp-proofs/AGENTS.md`](../AGENTS.md). Run a package with
`pnpm exec turbo run test --filter ./src/draft/exp-proofs/ux/<slug>`; validate artifacts with
`pnpm run draft:artifacts -- --staged`. Changing a proof here cascades into referencing epic
rollups — update them in the same diff (`pnpm run draft:cascade -- --staged`).
