export const title = 'Determine a Bindle\'s runtime requirements';
export const state = v => {
 if (v.phase === 'collect') return 'Bindle resources are being examined';
 const oci = v.result.includes('oci');
 const wasm = v.result.includes('wasm');
 if (oci && wasm) return 'Both OCI and Wasm are required';
 if (oci) return 'OCI is required';
 if (wasm) return 'Wasm is required';
 return 'No specific runtime is required';
};
export const step = action => action === 'Collect' ? 'inspect a resource' : action === 'Finish' ? 'publish runtime requirements' : 'finish';
