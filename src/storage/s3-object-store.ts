import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { MAX_STATEMENT_IMAGE_BYTES } from "../config/limits.js";
import {
  type DownloadedObject,
  ObjectNotFoundError,
  type ObjectMetadata,
  type StatementObjectStore,
} from "./object-store.js";

export interface S3ObjectStoreOptions {
  bucketName: string;
  region: string;
  client?: S3Client;
}

function isS3NotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };

  return (
    candidate.name === "NotFound" ||
    candidate.name === "NoSuchKey" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const iterator = (value as { [Symbol.asyncIterator]?: unknown })[
    Symbol.asyncIterator
  ];
  return typeof iterator === "function";
}

interface ReadableBodyStream {
  getReader(): {
    read(): Promise<{ done: boolean; value?: unknown }>;
    cancel?(reason?: unknown): Promise<void>;
    releaseLock?(): void;
  };
}

function isWebStreamTransformableBody(
  value: unknown,
): value is { transformToWebStream(): Promise<ReadableBodyStream> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "transformToWebStream" in value &&
    typeof value.transformToWebStream === "function"
  );
}

async function readObjectBody(body: unknown): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    if (body.byteLength > MAX_STATEMENT_IMAGE_BYTES) {
      throw new Error("S3 object is larger than the image limit");
    }
    return body;
  }

  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  if (isAsyncIterable(body)) {
    for await (const chunk of body) {
      if (!(chunk instanceof Uint8Array)) {
        throw new Error("S3 object Body contains an unsupported chunk");
      }

      totalLength += chunk.byteLength;
      if (totalLength > MAX_STATEMENT_IMAGE_BYTES) {
        throw new Error("S3 object is larger than the image limit");
      }
      chunks.push(chunk);
    }
  } else if (isWebStreamTransformableBody(body)) {
    const reader = (await body.transformToWebStream()).getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        if (!(result.value instanceof Uint8Array)) {
          throw new Error("S3 object Body contains an unsupported chunk");
        }

        totalLength += result.value.byteLength;
        if (totalLength > MAX_STATEMENT_IMAGE_BYTES) {
          await reader.cancel?.("S3 object is larger than the image limit");
          throw new Error("S3 object is larger than the image limit");
        }
        chunks.push(result.value);
      }
    } finally {
      reader.releaseLock?.();
    }
  } else {
    throw new Error("S3 object Body does not support bounded reading");
  }

  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class S3ObjectStore implements StatementObjectStore {
  private readonly bucketName: string;
  private readonly client: S3Client;

  public constructor(options: S3ObjectStoreOptions) {
    this.bucketName = options.bucketName;
    this.client =
      options.client ??
      new S3Client({
        region: options.region,
      });
  }

  public async createPresignedPutUrl(input: {
    key: string;
    contentType: "image/jpeg" | "image/png";
    expiresInSeconds: number;
  }): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: input.key,
      ContentType: input.contentType,
    });

    return getSignedUrl(this.client, command, {
      expiresIn: input.expiresInSeconds,
      signableHeaders: new Set(["content-type"]),
    });
  }

  public async headObject(key: string): Promise<ObjectMetadata> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucketName,
          Key: key,
        }),
      );

      if (typeof result.ContentLength !== "number") {
        throw new Error("S3 object Content-Length is missing");
      }

      return {
        contentType: result.ContentType,
        contentLength: result.ContentLength,
      };
    } catch (error) {
      if (isS3NotFoundError(error)) {
        throw new ObjectNotFoundError();
      }

      throw error;
    }
  }

  public async getObject(
    key: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<DownloadedObject> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: key,
        }),
        options.signal ? { abortSignal: options.signal } : undefined,
      );

      if (typeof result.ContentLength !== "number") {
        throw new Error("S3 object Content-Length is missing");
      }
      if (
        result.ContentLength < 1 ||
        result.ContentLength > MAX_STATEMENT_IMAGE_BYTES
      ) {
        throw new Error("S3 object Content-Length is outside the image limit");
      }

      const bytes = await readObjectBody(result.Body);
      if (bytes.byteLength !== result.ContentLength) {
        throw new Error("S3 object Body length does not match Content-Length");
      }

      return {
        bytes,
        contentType: result.ContentType,
        contentLength: result.ContentLength,
      };
    } catch (error) {
      if (isS3NotFoundError(error)) {
        throw new ObjectNotFoundError();
      }

      throw error;
    }
  }
}
