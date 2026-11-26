/** @module Interface wasi:io/streams@0.2.0 **/

export class InputStream {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  read(len: bigint): Uint8Array;
}

export class OutputStream {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  write(contents: Uint8Array): void;
  flush(): void;
}
