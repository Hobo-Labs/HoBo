export class CollectionEngineError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "CollectionEngineError";
    this.path = path;
  }
}
