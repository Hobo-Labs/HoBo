# Produce visual assets

Follow `AGENTS.md` and the user's request. Inspect the implemented surface, existing assets, and any supplied references. Produce only assets needed by the requested implementation; do not create planning documents, design documents, approval records, or unused review artifacts.

Preserve a supplied reference's visual role, composition, palette, and subject unless the user requests a change. Use semantic HTML, CSS, SVG, or canvas for controls, text, charts, and interface chrome. For raster assets, choose a suitable production size and format, preserve transparency when needed, and remove baked-in interface elements that the implementation owns.

Use the available image generation or editing tool when appropriate. Keep source references intact and remove temporary crops and intermediate files. Inspect each result and correct material defects before using it.

Implement the asset in the requested surface when working inline, then verify the rendered result at relevant sizes and states. When delegated only asset production, return the final asset paths and any material limitations to the parent. Do not require a separate mock or approval when the request authorizes the work.
