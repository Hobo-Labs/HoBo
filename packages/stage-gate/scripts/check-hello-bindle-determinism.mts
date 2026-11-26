import {
	buildHelloBindleComponent,
	emitEvidence,
} from "./hello-bindle-fixture.mts";

const first = await buildHelloBindleComponent();
const second = await buildHelloBindleComponent();

if (first.component.digest !== second.component.digest) {
	console.error(
		`digest mismatch: ${first.component.digest} vs ${second.component.digest}`,
	);
	process.exit(1);
}

if (!first.component.bytes.equals(second.component.bytes)) {
	console.error("component bytes differ between consecutive builds");
	process.exit(1);
}

emitEvidence({
	component_digest: first.component.digest,
	digest_sha256: first.component.digest,
	byte_length: String(first.component.bytes.length),
	media_type: first.component.mediaType,
	source_root: first.component.metadata.pathRemap,
});
