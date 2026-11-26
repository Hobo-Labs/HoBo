/**
 * Inline browser bootstrap injected into HTML responses for Bindle web apps.
 * Privacy-first: masks password/email/tel client-side; posts batches to
 * `/__hobo/replay/ingest`. Works without rrweb on the page (synthetic events);
 * upgrades when `window.rrweb.record` is present.
 */
import { REPLAY_ENV_KILL, REPLAY_FLAG_KEY } from "./policy.js";

export type BrowserBootstrapConfig = Readonly<{
	sessionId: string;
	stationId: string;
	bindleName: string;
	resourceName: string;
	ingestPath: string;
	/** When false, script no-ops immediately. */
	enabled: boolean;
	isolationClass?: string;
}>;

/**
 * Return a self-contained <script> tag (no external deps required).
 */
export function renderSessionReplayBootstrapScript(
	config: BrowserBootstrapConfig,
): string {
	const payload = JSON.stringify({
		sessionId: config.sessionId,
		stationId: config.stationId,
		bindleName: config.bindleName,
		resourceName: config.resourceName,
		ingestPath: config.ingestPath,
		enabled: config.enabled,
		isolationClass: config.isolationClass ?? "local-dev",
		flagKey: REPLAY_FLAG_KEY,
		killEnv: REPLAY_ENV_KILL,
	});
	// IIFE — no free globals except window.__HOBO_REPLAY__ handle for tests.
	return `<script data-hobo-replay="1">(function(){var C=${payload};if(!C.enabled)return;try{if(typeof process!=="undefined"&&process.env&&(process.env.HOBO_REPLAY==="0"||process.env.HOBO_REPLAY==="false"))return;}catch(e){}if(window.__HOBO_REPLAY_OFF__===true)return;var buf=[],seq=0,stopped=false;function mask(ev){try{var s=JSON.stringify(ev);if(/password|email|tel/i.test(s)&&ev&&ev.data){if(ev.data.value)ev.data.value="••••";if(ev.data.textContent&&ev.data.tagName==="INPUT")ev.data.textContent="••••";}return ev;}catch(e){return{type:0,timestamp:Date.now(),data:{err:"mask"}};}}function flush(){if(stopped||buf.length===0)return;var batch=buf.splice(0,buf.length);var body=JSON.stringify({sessionId:C.sessionId,stationId:C.stationId,bindleName:C.bindleName,resourceName:C.resourceName,seq:seq++,events:batch,isolationClass:C.isolationClass});try{if(navigator.sendBeacon){navigator.sendBeacon(C.ingestPath,new Blob([body],{type:"application/json"}));}else{fetch(C.ingestPath,{method:"POST",headers:{"content-type":"application/json"},body:body,keepalive:true});}}catch(e){}}function emit(ev){buf.push(mask(ev));if(buf.length>=20)flush();}function synth(){var t=Date.now();emit({type:2,timestamp:t,data:{tagName:"html",source:"hobo-bootstrap",href:location.href,resource:C.resourceName,bindle:C.bindleName}});document.addEventListener("click",function(e){var t2=Date.now();var el=e.target;emit({type:3,timestamp:t2,data:{source:2,x:e.clientX,y:e.clientY,tagName:el&&el.tagName,id:el&&el.id}});},true);document.addEventListener("input",function(e){var el=e.target;if(!el)return;var typ=(el.getAttribute&&el.getAttribute("type"))||el.type||"";emit({type:3,timestamp:Date.now(),data:{source:5,tagName:el.tagName,type:typ,value:typ==="password"||typ==="email"||typ==="tel"?"••••":"[masked]"}});},true);window.addEventListener("error",function(ev){emit({type:6,timestamp:Date.now(),data:{plugin:"error",message:String(ev.message||"error")}});});window.addEventListener("pagehide",function(){flush();stopped=true;});setInterval(flush,1000);}if(window.rrweb&&typeof window.rrweb.record==="function"){try{window.rrweb.record({emit:function(ev){emit(ev);},maskAllInputs:true,maskInputOptions:{password:true,email:true,tel:true}});}catch(e){synth();}}else{synth();}window.__HOBO_REPLAY__={sessionId:C.sessionId,flush:flush,stop:function(){flush();stopped=true;}};})();</script>`;
}

/**
 * Inject bootstrap immediately before </body> (or append if missing).
 */
export function injectSessionReplayBootstrap(
	html: string,
	config: BrowserBootstrapConfig,
): string {
	if (!config.enabled) return html;
	if (html.includes('data-hobo-replay="1"')) return html;
	const script = renderSessionReplayBootstrapScript(config);
	const lower = html.toLowerCase();
	const idx = lower.lastIndexOf("</body>");
	if (idx >= 0) {
		return `${html.slice(0, idx)}${script}${html.slice(idx)}`;
	}
	return `${html}${script}`;
}
