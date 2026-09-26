import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import type * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

export interface DatabaseStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  databaseSecurityGroup: ec2.ISecurityGroup;
}

export class DatabaseStack extends cdk.Stack {
  public readonly database: rds.DatabaseInstance;
  public readonly databaseSecret: secretsmanager.ISecret;

  public constructor(
    scope: Construct,
    id: string,
    props: DatabaseStackProps,
  ) {
    const { vpc, databaseSecurityGroup, ...stackProps } = props;
    super(scope, id, stackProps);

    this.database = new rds.DatabaseInstance(this, "Database", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      credentials: rds.Credentials.fromGeneratedSecret("app"),
      databaseName: "statement_analyzer",
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        ec2.InstanceSize.MICRO,
      ),
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      storageType: rds.StorageType.GP3,
      backupRetention: cdk.Duration.days(7),
      deleteAutomatedBackups: true,
      deletionProtection: false,
      multiAz: false,
      publiclyAccessible: false,
      storageEncrypted: true,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
      vpc: vpc as unknown as ec2.IVpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [databaseSecurityGroup],
    });

    if (!this.database.secret) {
      throw new Error("Database secret was not created");
    }
    this.databaseSecret = this.database.secret;

    new cdk.CfnOutput(this, "DatabaseEndpoint", {
      value: this.database.instanceEndpoint.hostname,
      description: "Private RDS PostgreSQL endpoint",
    });
    new cdk.CfnOutput(this, "DatabaseSecretArn", {
      value: this.databaseSecret.secretArn,
      description: "RDS credentials Secret ARN",
    });
  }
}
