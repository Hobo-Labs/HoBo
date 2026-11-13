/**
 * A tiny stand-in for the gVisor release tarball, laid out like the real one
 * (`containerd-shim-runsc-v1`, `runsc`, `gvisor-bin/`), made once with
 * `tar --owner=0 --group=0 -cf - … | bzip2 -9` and embedded here. Its `runsc`
 * is a shell script printing the pinned release's version line.
 */
export const FIXTURE_TARBALL =
	"QlpoOTFBWSZTWaRrJDoAAO7/jM2QIEB4A/+QAEACCP7n3yAAQAAAgEgwAPY2hKKnk1NNB6mmnqHqBkAGQ00CSSJsUDRoAAAAPUNAqpMqeTJtSZMI0GTT1MaBAyV+gq+Vb8OVh7wYuDCE0UkCyZqGeFsCYHUt6SMAzFBAiQ0ccl8qYKj6OiUPejpn9vLFY68rWPlZouwz2ULYacRBdWRBv3N+YLZ+ZFI/sM7bpl5XVfV3YyNSaREiYFNmsp3d5ZWrFkvSuYGQM6hpUOaEXnS1GJ2vs+W9xrTbG7hhkR51JKU8FT9OrB+TpiBPG6BBUANEHJ+vGEgmr86okEm+wgrnzpgoDKBNOCjkuCXN+RpQCB/F3JFOFCQpGskOgA==";

/** `sha512sum` of the decoded FIXTURE_TARBALL. */
export const FIXTURE_SHA512 =
	"b7ca4a1791896e01ae85d3b07a9d909aa801c262e0fa6758f7177724b5e68c66c2992252d4ada32499453924afe131fb771d34fb61ccde79a3271db28090627f";
