import assert from "node:assert/strict";
import { test } from "node:test";
import { S3Client } from "@aws-sdk/client-s3";
import { ObjectNotFoundError } from "../src/storage/object-store.ts";
import { S3ObjectStore } from "../src/storage/s3-object-store.ts";

test("S3ObjectStoreはContent-Typeを署名したPresigned PUT URLを作成する", async () => {
  const store = new S3ObjectStore({
    bucketName: "statement-bucket",
    region: "ap-northeast-1",
    client: new S3Client({
      region: "ap-northeast-1",
      credentials: {
        accessKeyId: "AKIAEXAMPLE",
        secretAccessKey: "secret-example",
      },
    }),
  });

  const url = await store.createPresignedPutUrl({
    key: "statements/statement-id/source",
    contentType: "image/jpeg",
    expiresInSeconds: 300,
  });
  const parsed = new URL(url);

  assert.equal(parsed.hostname, "statement-bucket.s3.ap-northeast-1.amazonaws.com");
  assert.equal(parsed.pathname, "/statements/statement-id/source");
  assert.equal(parsed.searchParams.get("X-Amz-Expires"), "300");
  assert.equal(parsed.searchParams.get("X-Amz-SignedHeaders"), "content-type;host");
});

test("S3ObjectStoreはHeadObjectのMetadataをアプリケーション型へ変換する", async () => {
  let commandInput: Record<string, unknown> | undefined;
  const client = {
    send: async (command: { input: Record<string, unknown> }) => {
      commandInput = command.input;
      return { ContentType: "image/png", ContentLength: 2048 };
    },
  } as unknown as S3Client;
  const store = new S3ObjectStore({
    bucketName: "statement-bucket",
    region: "ap-northeast-1",
    client,
  });

  const result = await store.headObject("statements/statement-id/source");

  assert.deepEqual(result, {
    contentType: "image/png",
    contentLength: 2048,
  });
  assert.deepEqual(commandInput, {
    Bucket: "statement-bucket",
    Key: "statements/statement-id/source",
  });
});

test("S3ObjectStoreはS3の404をObjectNotFoundErrorへ変換する", async () => {
  const client = {
    send: async () => {
      const error = new Error("not found");
      error.name = "NotFound";
      throw error;
    },
  } as unknown as S3Client;
  const store = new S3ObjectStore({
    bucketName: "statement-bucket",
    region: "ap-northeast-1",
    client,
  });

  await assert.rejects(
    store.headObject("statements/statement-id/source"),
    ObjectNotFoundError,
  );
});
