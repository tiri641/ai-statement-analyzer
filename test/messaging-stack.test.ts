import assert from "node:assert/strict";
import { test } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { MessagingStack } from "../infra/lib/messaging-stack.ts";

test("MessagingStackはStandard QueueとDLQを安全な設定で定義する", () => {
  const app = new cdk.App();
  const stack = new MessagingStack(app, "MessagingStack", {
    env: { account: "123456789012", region: "ap-northeast-1" },
  });
  const template = Template.fromStack(stack);

  template.resourceCountIs("AWS::SQS::Queue", 2);
  template.hasResourceProperties("AWS::SQS::Queue", {
    MessageRetentionPeriod: 345600,
    ReceiveMessageWaitTimeSeconds: 20,
    VisibilityTimeout: 300,
    SqsManagedSseEnabled: true,
    RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
  });
  template.hasResourceProperties("AWS::SQS::Queue", {
    MessageRetentionPeriod: 1209600,
    SqsManagedSseEnabled: true,
  });
  template.resourceCountIs("AWS::SQS::QueuePolicy", 2);

  const queues = template.findResources("AWS::SQS::Queue");
  for (const queue of Object.values(queues)) {
    assert.equal(queue.DeletionPolicy, "Delete");
    assert.equal(queue.UpdateReplacePolicy, "Delete");
  }

  template.hasOutput("AnalyzeQueueUrl", {});
  template.hasOutput("AnalyzeQueueArn", {});
  template.hasOutput("AnalyzeDlqUrl", {});
  template.hasOutput("AnalyzeDlqArn", {});
});
