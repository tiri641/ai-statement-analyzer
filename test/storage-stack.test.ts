import assert from "node:assert/strict";
import { test } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { StorageStack } from "../infra/lib/storage-stack.ts";

test("StorageStackは非公開・暗号化・Lifecycle付きのS3バケットを定義する", () => {
  const app = new cdk.App();
  const stack = new StorageStack(app, "StorageStack", {
    env: { account: "123456789012", region: "ap-northeast-1" },
    frontendOrigin: "http://localhost:5173",
    rawRetentionDays: 7,
  });
  const template = Template.fromStack(stack);

  template.resourceCountIs("AWS::S3::Bucket", 1);
  template.hasResourceProperties("AWS::S3::Bucket", {
    BucketEncryption: {
      ServerSideEncryptionConfiguration: [
        {
          ServerSideEncryptionByDefault: {
            SSEAlgorithm: "AES256",
          },
        },
      ],
    },
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
    CorsConfiguration: {
      CorsRules: [
        {
          AllowedHeaders: ["content-type"],
          AllowedMethods: ["PUT"],
          AllowedOrigins: ["http://localhost:5173"],
          ExposedHeaders: ["ETag"],
          MaxAge: 300,
        },
      ],
    },
    LifecycleConfiguration: {
      Rules: Match.arrayWith([
        Match.objectLike({
          ExpirationInDays: 7,
          Prefix: "statements/",
          Status: "Enabled",
        }),
        Match.objectLike({
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
          Status: "Enabled",
        }),
      ]),
    },
  });

  template.hasResource("AWS::S3::Bucket", {
    DeletionPolicy: "Retain",
    UpdateReplacePolicy: "Retain",
  });
  template.hasResourceProperties("AWS::S3::BucketPolicy", {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: "s3:*",
          Effect: "Deny",
          Condition: { Bool: { "aws:SecureTransport": "false" } },
        }),
        Match.objectLike({
          Action: "s3:*",
          Effect: "Deny",
          Condition: { NumericLessThan: { "s3:TlsVersion": 1.2 } },
        }),
      ]),
    },
  });
  const bucket = template.findResources("AWS::S3::Bucket");
  const bucketProperties = Object.values(bucket)[0]?.Properties as
    | Record<string, unknown>
    | undefined;
  assert.ok(bucketProperties);
  assert.equal("BucketName" in bucketProperties, false);
});

test("StorageStackは不正な保持日数を拒否する", () => {
  const app = new cdk.App();

  assert.throws(
    () =>
      new StorageStack(app, "InvalidStorageStack", {
        frontendOrigin: "http://localhost:5173",
        rawRetentionDays: 0,
      }),
    /rawRetentionDays must be a positive integer/,
  );
});

test("StorageStackはbootstrap versionのSSM参照をテンプレートへ追加しない", () => {
  const app = new cdk.App();
  const stack = new StorageStack(app, "StorageStackWithoutBootstrapRule", {
    env: { account: "123456789012", region: "ap-northeast-1" },
    frontendOrigin: "http://localhost:5173",
    rawRetentionDays: 7,
  });
  const template = Template.fromStack(stack).toJSON() as Record<string, unknown>;
  const parameters = (template.Parameters ?? {}) as Record<string, unknown>;
  const rules = (template.Rules ?? {}) as Record<string, unknown>;

  assert.equal("BootstrapVersion" in parameters, false);
  assert.equal("CheckBootstrapVersion" in rules, false);
});
