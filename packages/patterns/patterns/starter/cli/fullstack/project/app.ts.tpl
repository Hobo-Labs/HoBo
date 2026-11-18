import { createHobo, create{{runtimeName}}Store, type HandlerResponse } from "./src/_generated/index.ts";

const hobo = createHobo({ name: "{{name}}", template: "{{template}}" });
export const resource = hobo.resource("{{resourceName}}", create{{runtimeName}}Store());

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function page(message: string, notice: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{name}} · HoBo starter</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #f5f2ea; color: #1d3029; font-family: system-ui, sans-serif; }
    .shell { width: min(1120px, calc(100% - 48px)); margin: 0 auto; }
    header { min-height: 84px; display: flex; align-items: center; justify-content: space-between; gap: 20px; border-bottom: 1px solid #cbd3c9; }
    .brand { display: flex; align-items: center; gap: 12px; font-weight: 750; letter-spacing: -.02em; }
    .brand-mark { display: grid; place-items: center; width: 36px; height: 36px; background: #215840; color: white; border-radius: 10px; font-size: 18px; }
    .environment { font-size: 13px; color: #435e50; }
    main { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(280px, .9fr); gap: clamp(40px, 8vw, 112px); align-items: start; padding: clamp(64px, 10vw, 124px) 0; }
    h1 { max-width: 12ch; margin: 0 0 22px; font: 500 clamp(42px, 5.5vw, 68px)/1.02 Georgia, serif; letter-spacing: -.035em; text-wrap: balance; }
    .intro { max-width: 48ch; color: #43594d; font-size: 17px; line-height: 1.65; }
    .detail { margin-top: 42px; padding-top: 20px; border-top: 1px solid #cbd3c9; color: #43594d; font-size: 14px; line-height: 1.6; }
    section { background: #fffdf8; border-radius: 16px; padding: clamp(24px, 4vw, 38px); box-shadow: 0 18px 48px rgba(34, 57, 43, .10); }
    section h2 { margin: 0 0 10px; font-size: 23px; letter-spacing: -.02em; }
    section p { margin: 0 0 26px; color: #43594d; line-height: 1.55; }
    label { display: block; margin-bottom: 9px; font-size: 14px; font-weight: 700; }
    textarea { width: 100%; min-height: 150px; resize: vertical; border: 1px solid #9baba0; border-radius: 10px; background: #fff; color: #1d3029; padding: 14px; font: inherit; line-height: 1.5; }
    textarea:focus-visible, button:focus-visible { outline: 3px solid #ca7350; outline-offset: 3px; }
    button { margin-top: 18px; min-height: 46px; padding: 0 20px; border: 0; border-radius: 10px; background: #215840; color: white; font: inherit; font-weight: 700; cursor: pointer; }
    button:hover { background: #153e2d; }
    .notice { min-height: 22px; margin: 14px 0 0; color: #215840; font-size: 14px; }
    footer { padding: 22px 0 32px; border-top: 1px solid #cbd3c9; color: #43594d; font-size: 13px; }
    @media (max-width: 700px) { .shell { width: min(100% - 32px, 540px); } main { grid-template-columns: 1fr; padding: 58px 0 72px; } .detail { margin-top: 28px; } }
  </style>
</head>
<body>
  <div class="shell">
    <header><div class="brand"><span class="brand-mark">H</span><span>{{name}}</span></div><span class="environment">Local starter</span></header>
    <main>
      <div>
        <h1>A small place to start.</h1>
        <p class="intro">Your app is running. Change a note to see the page and its resource working together.</p>
        <p class="detail">This starter keeps the note in memory while the local app is running.</p>
      </div>
      <section aria-labelledby="note-heading">
        <h2 id="note-heading">Your first note</h2>
        <p>Make it yours, then save it to the local resource.</p>
        <form method="post" action="/note">
          <label for="message">Note</label>
          <textarea id="message" name="message" maxlength="160" required>${escapeText(message)}</textarea>
          <button type="submit">Save note</button>
          <p class="notice" role="status">${escapeText(notice)}</p>
        </form>
      </section>
    </main>
    <footer>Built with HoBo · {{name}}</footer>
  </div>
</body>
</html>`;
}

export const api = hobo.api("{{route}}", async (request): Promise<HandlerResponse> => {
  const [path, query] = request.path.split("?");
  const method = request.method ?? "GET";
  const stored = await resource.get("{{seedKey}}");
  const current = stored?.message ?? "{{message}}";

  if (path === "/" && method === "GET") {
    const notice = new URLSearchParams(query).has("saved") ? "Note saved." : "";
    return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: page(current, notice) };
  }

  if (path === "/note" && method === "POST") {
    const body = Object.prototype.toString.call(request.body) === "[object String]" ? String(request.body) : "";
    const message = new URLSearchParams(body).get("message")?.trim() ?? "";
    if (!message || message.length > 160) {
      return { status: 400, headers: { "content-type": "text/html; charset=utf-8" }, body: page(current, "Enter a note of 1 to 160 characters.") };
    }
    await resource.put("{{seedKey}}", { message });
    return { status: 303, headers: { location: "/?saved=1" }, body: "" };
  }

  if (path === "{{route}}" && method === "GET") {
    return { status: 200, body: { template: "{{template}}", path: request.path, record: { key: "{{seedKey}}", value: { message: current } } } };
  }

  return { status: 404, body: { template: "{{template}}", path: request.path, error: "Not found" } };
});
