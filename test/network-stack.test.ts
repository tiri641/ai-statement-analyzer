import assert from "node:assert/strict";
import { test } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { NetworkStack } from "../infra/lib/network-stack.ts";

test("NetworkStackは2 AZ、NAT 1台、S3 Gateway Endpoint、分離したSecurity Groupを定義する", () => {
  const app = new cdk.App();
  const stack = new NetworkStack(app, "NetworkStack", {
    env: { account: "123456789012", region: "ap-northeast-1" },
  });
  const template = Template.fromStack(stack);

  template.resourceCountIs("AWS::EC2::VPC", 1);
  template.resourceCountIs("AWS::EC2::NatGateway", 1);
  template.resourceCountIs("AWS::EC2::VPCEndpoint", 1);
  template.resourceCountIs("AWS::EC2::SecurityGroup", 4);

  template.hasResourceProperties("AWS::EC2::VPCEndpoint", {
    VpcEndpointType: "Gateway",
    ServiceName: { "Fn::Join": ["", ["com.amazonaws.", { Ref: "AWS::Region" }, ".s3"]] },
  });

  assert.equal(stack.vpc.publicSubnets.length, 2);
  assert.equal(stack.vpc.privateSubnets.length, 2);
  assert.equal(stack.vpc.isolatedSubnets.length, 2);

  const synthesized = template.toJSON() as {
    Parameters?: Record<string, unknown>;
  };
  assert.ok(synthesized.Parameters?.BootstrapVersion);
});
