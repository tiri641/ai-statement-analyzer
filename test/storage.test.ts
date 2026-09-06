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

test("S3ObjectStoreはGetObjectのBodyをboundedなUint8Arrayへ変換する", async () => {
  let commandInput: Record<string, unknown> | undefined;
  const client = {
    send: async (command: { input: Record<string, unknown> }) => {
      commandInput = command.input;
      async function* body() {
        yield new Uint8Array([1, 2]);
        yield new Uint8Array([3, 4]);
      }
      return {
        Body: body(),
        ContentType: "image/jpeg",
        ContentLength: 4,
      };
    },
  } as unknown as S3Client;
  const store = new S3ObjectStore({
    bucketName: "statement-bucket",
    region: "ap-northeast-1",
    client,
  });

  const result = await store.getObject("statements/statement-id/source");

  assert.deepEqual(result, {
    bytes: new Uint8Array([1, 2, 3, 4]),
    contentType: "image/jpeg",
    contentLength: 4,
  });
  assert.deepEqual(commandInput, {
    Bucket: "statement-bucket",
    Key: "statements/statement-id/source",
  });
});

test("S3ObjectStoreはWeb Stream Bodyも上限内でチャンク変換する", async () => {
  const client = {
    send: async () => ({
      Body: {
        transformToWebStream: async () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2]));
              controller.enqueue(new Uint8Array([3, 4]));
              controller.close();
            },
          }),
      },
      ContentType: "image/jpeg",
      ContentLength: 4,
    }),
  } as unknown as S3Client;
  const store = new S3ObjectStore({
    bucketName: "statement-bucket",
    region: "ap-northeast-1",
    client,
  });

  const result = await store.getObject("statements/statement-id/source");

  assert.deepEqual(result.bytes, new Uint8Array([1, 2, 3, 4]));
});

test("S3ObjectStoreはGetObjectへAbortSignalを渡す", async () => {
  const abortController = new AbortController();
  let sendOptions: { abortSignal?: AbortSignal } | undefined;
  const client = {
    send: async (
      _command: { input: Record<string, unknown> },
      options?: { abortSignal?: AbortSignal },
    ) => {
      sendOptions = options;
      return {
        Body: new Uint8Array([1]),
        ContentType: "image/png",
        ContentLength: 1,
      };
    },
  } as unknown as S3Client;
  const store = new S3ObjectStore({
    bucketName: "statement-bucket",
    region: "ap-northeast-1",
    client,
  });

  await store.getObject("statements/statement-id/source", {
    signal: abortController.signal,
  });

  assert.equal(sendOptions?.abortSignal, abortController.signal);
});

test("S3ObjectStoreはGetObjectのBody長不一致を拒否する", async () => {
  const client = {
    send: async () => ({
      Body: new Uint8Array([1]),
      ContentType: "image/jpeg",
      ContentLength: 2,
    }),
  } as unknown as S3Client;
  const store = new S3ObjectStore({
    bucketName: "statement-bucket",
    region: "ap-northeast-1",
    client,
  });

  await assert.rejects(
    store.getObject("statements/statement-id/source"),
    /Body length does not match Content-Length/,
  );
});

test("S3ObjectStoreはGetObjectの404をObjectNotFoundErrorへ変換する", async () => {
  const client = {
    send: async () => {
      const error = new Error("not found");
      error.name = "NoSuchKey";
      throw error;
    },
  } as unknown as S3Client;
  const store = new S3ObjectStore({
    bucketName: "statement-bucket",
    region: "ap-northeast-1",
    client,
  });

  await assert.rejects(
    store.getObject("statements/statement-id/source"),
    ObjectNotFoundError,
  );
});
