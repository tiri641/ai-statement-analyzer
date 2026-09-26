import assert from "node:assert/strict";
import { test } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { DatabaseStack } from "../infra/lib/database-stack.ts";
import { NetworkStack } from "../infra/lib/network-stack.ts";

test("DatabaseStackはPrivateなPostgreSQLとSecrets Managerを定義する", () => {
  const app = new cdk.App();
  const network = new NetworkStack(app, "NetworkStack", {
    env: { account: "123456789012", region: "ap-northeast-1" },
  });
  const stack = new DatabaseStack(app, "DatabaseStack", {
    env: { account: "123456789012", region: "ap-northeast-1" },
    vpc: network.vpc,
    databaseSecurityGroup: network.databaseSecurityGroup,
  });
  const template = Template.fromStack(stack);

  template.hasResourceProperties("AWS::RDS::DBInstance", {
    Engine: "postgres",
    DBInstanceClass: "db.t4g.micro",
    DBName: "statement_analyzer",
    AllocatedStorage: "20",
    StorageType: "gp3",
    MultiAZ: false,
    PubliclyAccessible: false,
    StorageEncrypted: true,
    BackupRetentionPeriod: 7,
  });
  template.hasResource("AWS::RDS::DBInstance", {
    DeletionPolicy: "Snapshot",
    UpdateReplacePolicy: "Snapshot",
  });
  template.resourceCountIs("AWS::SecretsManager::Secret", 1);
  assert.ok(stack.database.secret);
});
