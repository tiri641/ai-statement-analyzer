export interface ObjectMetadata {
  contentType: string | undefined;
  contentLength: number;
}

export interface DownloadedObject extends ObjectMetadata {
  bytes: Uint8Array;
}

export interface StatementObjectStore {
  createPresignedPutUrl(input: {
    key: string;
    contentType: "image/jpeg" | "image/png";
    expiresInSeconds: number;
  }): Promise<string>;
  headObject(key: string): Promise<ObjectMetadata>;
  getObject(
    key: string,
    options?: { signal?: AbortSignal },
  ): Promise<DownloadedObject>;
}

export class ObjectNotFoundError extends Error {
  public constructor() {
    super("S3 object was not found");
    this.name = "ObjectNotFoundError";
  }
}
