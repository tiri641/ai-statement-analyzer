import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
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
}
