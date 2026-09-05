import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";

export interface StorageStackProps extends cdk.StackProps {
  frontendOrigin: string;
  rawRetentionDays: number;
}

export class StorageStack extends cdk.Stack {
  public readonly statementBucket: s3.Bucket;

  public constructor(
    scope: Construct,
    id: string,
    props: StorageStackProps,
  ) {
    const { frontendOrigin, rawRetentionDays, ...stackProps } = props;

    super(scope, id, stackProps);

    if (!Number.isInteger(rawRetentionDays) || rawRetentionDays < 1) {
      throw new Error("rawRetentionDays must be a positive integer");
    }

    if (!frontendOrigin.startsWith("http://") && !frontendOrigin.startsWith("https://")) {
      throw new Error("frontendOrigin must use http or https");
    }

    this.statementBucket = new s3.Bucket(this, "StatementBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: "ExpireStatementImages",
          enabled: true,
          prefix: "statements/",
          expiration: cdk.Duration.days(rawRetentionDays),
        },
        {
          id: "AbortIncompleteMultipartUploads",
          enabled: true,
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        },
      ],
      cors: [
        {
          allowedOrigins: [frontendOrigin],
          allowedMethods: [s3.HttpMethods.PUT],
          allowedHeaders: ["content-type"],
          exposedHeaders: ["ETag"],
          maxAge: 300,
        },
      ],
    });

    new cdk.CfnOutput(this, "S3BucketName", {
      value: this.statementBucket.bucketName,
      description: "明細画像を保存するS3バケット名",
    });
  }
}
