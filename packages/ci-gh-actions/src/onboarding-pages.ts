import { createHash } from "node:crypto";

const style = `
:root { color-scheme: light; font-family: system-ui, sans-serif; color: #101010; background: #f2f1ec; }
body { margin: 0; padding: 2rem 1rem; }
main { max-width: 36rem; margin: 4vh auto; padding: 2rem; background: #ffffff; border: 3px solid #101010; box-shadow: 8px 8px 0 #101010; }
h1 { font-size: clamp(1.8rem, 6vw, 2.6rem); line-height: 1.1; }
p { line-height: 1.5; }
label { display: block; font-weight: 700; margin: 1rem 0; }
input { display: block; box-sizing: border-box; width: 100%; margin-top: .4rem; padding: .7rem; border: 2px solid #101010; background: #fff; color: #101010; font: inherit; }
button { padding: .7rem 1rem; border: 2px solid #101010; box-shadow: 3px 3px 0 #101010; background: #f2f1ec; color: #101010; font: inherit; font-weight: 700; cursor: pointer; }
:focus-visible { outline: 3px solid #bd2626; outline-offset: 3px; }
#status { min-height: 1.5em; }
@media (max-width: 480px) { main { padding: 1.25rem; margin: 1rem auto; } }
`;
function page(title: string, body: string, script: string): Response {
	const digest = createHash("sha256").update(script).digest("base64");
	const styleDigest = createHash("sha256").update(style).digest("base64");
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${style}</style></head><body>${body}<script>${script}</script></body></html>`,
		{
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
				"referrer-policy": "no-referrer",
				"x-content-type-options": "nosniff",
				"content-security-policy": `default-src 'none'; script-src 'sha256-${digest}'; style-src 'sha256-${styleDigest}'; connect-src 'self'; form-action 'self' https://github.com; base-uri 'none'; frame-ancestors 'none'`,
			},
		},
	);
}
const bootstrapScript = `
const form = document.getElementById('setup');
const status = document.getElementById('status');
const tokenField = document.getElementById('bootstrap-token');
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  status.textContent = 'Preparing GitHub App registration…';
  try {
    const response = await fetch('/v1/app-bootstrap/start', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tokenField.value },
      body: JSON.stringify({ name: form.elements.appName.value })
    });
    tokenField.value = '';
    if (!response.ok) throw new Error('Unable to start registration. Check the operator token and relay configuration.');
    const result = await response.json();
    const action = new URL(result.action);
    if (action.origin !== 'https://github.com' || action.pathname !== '/settings/apps/new') throw new Error('Unexpected GitHub registration address.');
    const githubForm = document.createElement('form');
    githubForm.method = 'POST'; githubForm.action = action.href;
    const manifest = document.createElement('input');
    manifest.type = 'hidden'; manifest.name = 'manifest'; manifest.value = JSON.stringify(result.manifest);
    githubForm.append(manifest); document.body.append(githubForm); githubForm.submit();
  } catch (error) { tokenField.value = ''; status.textContent = error.message || 'Registration could not start.'; }
});`;
const deviceFlowSetup =
	"<p>After GitHub creates the App, enable <strong>Device Flow</strong> in its settings before finishing HoBo setup. This enables user authorization from CLI and headless environments.</p>";
const accountScript = `
const connect = document.getElementById('connect');
const install = document.getElementById('install');
const status = document.getElementById('status');
const tokenField = document.getElementById('account-token');
connect.addEventListener('submit', async (event) => {
  event.preventDefault(); status.textContent = 'Connecting to GitHub…';
  try {
    const authHeaders = tokenField ? { authorization: 'Bearer ' + tokenField.value } : {};
    const response = await fetch('/v1/app-registration/oauth/start', { method: 'POST', headers: authHeaders });
    if (tokenField) tokenField.value = '';
    if (!response.ok) throw new Error(tokenField ? 'Unable to start GitHub authorization. Check the account token.' : 'Unable to start GitHub authorization. Check your account access.');
    const result = await response.json(); const target = new URL(result.authorizeUrl);
    if (target.origin !== 'https://github.com' || target.pathname !== '/login/oauth/authorize') throw new Error('Unexpected GitHub authorization address.');
    location.assign(target.href);
  } catch (error) { if (tokenField) tokenField.value = ''; status.textContent = error.message || 'Authorization could not start.'; }
});
install.addEventListener('click', async () => {
  status.textContent = 'Preparing GitHub installation…';
  try {
    const response = await fetch('/v1/app-registration/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ purpose: 'install' }) });
    if (!response.ok) throw new Error('Connect your GitHub account first.');
    const result = await response.json(); const target = new URL(result.installationUrl);
    if (target.origin !== 'https://github.com' || !/^\\/apps\\/[A-Za-z0-9-]+\\/installations\\/new$/.test(target.pathname)) throw new Error('Unexpected GitHub installation address.');
    location.assign(target.href);
  } catch (error) { status.textContent = error.message || 'Installation could not start.'; }
});
const phase = new URL(location.href).searchParams.get('status');
if (phase === 'connected') status.textContent = 'Continue to install the GitHub App.';
if (phase === 'installed') status.textContent = 'Review your connected installations in HoBo.';
`;
export function appBootstrapPage(): Response {
	return page(
		"Set up HoBo CI",
		`<main><h1>Set up HoBo CI</h1><p>Create the HoBo CI GitHub App using the platform operator token.</p>${deviceFlowSetup}<form id="setup" method="post" action="/v1/app-bootstrap/start"><label>App name <input name="appName" value="HoBo CI" required maxlength="100"></label><label>Operator token <input id="bootstrap-token" type="password" required autocomplete="off"></label><button type="submit">Create GitHub App</button></form><p id="status" role="status"></p></main>`,
		bootstrapScript,
	);
}

const ownerBootstrapScript = `
const form = document.getElementById('setup');
const status = document.getElementById('status');
const invitation = location.hash.slice(1);
form.addEventListener('submit', async (event) => {
  event.preventDefault(); status.textContent = 'Preparing GitHub App registration…';
  try {
    const response = await fetch('/v1/app-bootstrap/start', {
      method: 'POST', headers: { 'content-type': 'application/json', ...(invitation ? { 'authorization': 'Bearer ' + invitation } : {}) },
      body: JSON.stringify({ name: form.elements.appName.value })
    });
    if (!response.ok) throw new Error('Unable to start registration.');
    history.replaceState(null, '', location.pathname + location.search);
    const result = await response.json(); const action = new URL(result.action);
    if (action.origin !== 'https://github.com' || action.pathname !== '/settings/apps/new') throw new Error('Unexpected GitHub registration address.');
    const githubForm = document.createElement('form');
    githubForm.method = 'POST'; githubForm.action = action.href;
    const manifest = document.createElement('input');
    manifest.type = 'hidden'; manifest.name = 'manifest'; manifest.value = JSON.stringify(result.manifest);
    githubForm.append(manifest); document.body.append(githubForm); githubForm.submit();
  } catch (error) { status.textContent = error.message || 'Registration could not start.'; }
});`;

/** Public start is safe only when the server validates the converted App owner. */
export function appOwnerBootstrapPage(): Response {
	return page(
		"Set up HoBo CI",
		`<main><h1>Set up HoBo CI</h1><p>Sign in to GitHub as the HoBo repository owner to create the App.</p>${deviceFlowSetup}<form id="setup" method="post" action="/v1/app-bootstrap/start"><label>App name <input name="appName" value="HoBo CI" required maxlength="100"></label><button type="submit">Create GitHub App</button></form><p id="status" role="status"></p></main>`,
		ownerBootstrapScript,
	);
}

const ownerReauthScript = `
const form = document.getElementById('reauth');
const status = document.getElementById('status');
form.addEventListener('submit', async (event) => {
  event.preventDefault(); status.textContent = 'Connecting to GitHub…';
  try {
    const response = await fetch('/v1/app-bootstrap/reauth/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (!response.ok) throw new Error('Unable to reconnect to GitHub.');
    const result = await response.json(); const target = new URL(result.authorizeUrl);
    if (target.origin !== 'https://github.com' || target.pathname !== '/login/oauth/authorize') throw new Error('Unexpected GitHub authorization address.');
    location.assign(target.href);
  } catch (error) { status.textContent = error.message || 'Reconnection could not start.'; }
});`;

export function appOwnerReauthPage(): Response {
	return page(
		"Reconnect GitHub to HoBo CI",
		`<main><h1>Reconnect GitHub</h1><p>Sign in as the HoBo repository owner to continue.</p><form id="reauth" method="post" action="/v1/app-bootstrap/reauth/start"><button type="submit">Connect GitHub</button></form><p id="status" role="status"></p></main>`,
		ownerReauthScript,
	);
}
export function appInstallationPage(): Response {
	return page(
		"Connect GitHub to HoBo CI",
		`<main><h1>Connect GitHub to HoBo CI</h1><p>Connect your GitHub account, then install the App.</p><form id="connect" method="post" action="/v1/app-registration/oauth/start"><label>HoBo account token <input id="account-token" type="password" required autocomplete="off"></label><button type="submit">Connect GitHub</button></form><p><button type="button" id="install">Install GitHub App</button></p><p id="status" role="status"></p></main>`,
		accountScript,
	);
}

/** The host selects this page only for a verified owner bootstrap session. */
export function appOwnerInstallationPage(): Response {
	return page(
		"Connect GitHub to HoBo CI",
		`<main><h1>Connect GitHub to HoBo CI</h1><p>Connect your GitHub account, then install the App.</p><form id="connect" method="post" action="/v1/app-registration/oauth/start"><button type="submit">Connect GitHub</button></form><p><button type="button" id="install">Install GitHub App</button></p><p id="status" role="status"></p></main>`,
		accountScript,
	);
}
