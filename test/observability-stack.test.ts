import assert from "node:assert/strict";
import { test } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { MessagingStack } from "../infra/lib/messaging-stack.ts";
import { ObservabilityStack } from "../infra/lib/observability-stack.ts";

test("ObservabilityStackはログ保持、Metrics、Alarmを定義する", () => {
  const app = new cdk.App();
  const messaging = new MessagingStack(app, "MessagingStack", {
    env: { account: "123456789012", region: "ap-northeast-1" },
  });
  const stack = new ObservabilityStack(app, "ObservabilityStack", {
    env: { account: "123456789012", region: "ap-northeast-1" },
    analyzeQueue: messaging.analyzeQueue,
    alertsTopic: messaging.analyzeAlertsTopic,
  });
  const template = Template.fromStack(stack);

  template.resourceCountIs("AWS::Logs::LogGroup", 2);
  template.resourceCountIs("AWS::Logs::MetricFilter", 3);
  template.resourceCountIs("AWS::CloudWatch::Alarm", 3);
  template.hasResourceProperties("AWS::Logs::LogGroup", {
    RetentionInDays: 30,
  });
  const logGroups = template.findResources("AWS::Logs::LogGroup");
  for (const logGroup of Object.values(logGroups)) {
    assert.equal(logGroup.DeletionPolicy, "Retain");
  }
  template.hasResourceProperties("AWS::CloudWatch::Alarm", {
    AlarmName: "ai-statement-analyzer-analyze-oldest-message",
    Threshold: 600,
    EvaluationPeriods: 5,
    DatapointsToAlarm: 5,
    MetricName: "ApproximateAgeOfOldestMessage",
    Namespace: "AWS/SQS",
  });

  const alarms = template.findResources("AWS::CloudWatch::Alarm");
  for (const alarm of Object.values(alarms)) {
    assert.equal(alarm.Properties.AlarmActions?.length, 1);
  }
});
