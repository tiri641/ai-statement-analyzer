import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

const METRIC_NAMESPACE = "AIStatementAnalyzer/Observability";
const LOG_RETENTION_DAYS = 30;
const DEFAULT_OLDEST_MESSAGE_AGE_SECONDS = 600;
const DEFAULT_WORKER_ERROR_THRESHOLD = 3;
const DEFAULT_BEDROCK_ERROR_THRESHOLD = 3;

export interface ObservabilityStackProps extends cdk.StackProps {
  analyzeQueue: sqs.IQueue;
  alertsTopic: sns.ITopic;
  oldestMessageAgeSeconds?: number;
  workerErrorThreshold?: number;
  bedrockErrorThreshold?: number;
}

export class ObservabilityStack extends cdk.Stack {
  public readonly apiLogGroup: logs.LogGroup;
  public readonly workerLogGroup: logs.LogGroup;

  public constructor(
    scope: Construct,
    id: string,
    props: ObservabilityStackProps,
  ) {
    const {
      analyzeQueue,
      alertsTopic,
      oldestMessageAgeSeconds = DEFAULT_OLDEST_MESSAGE_AGE_SECONDS,
      workerErrorThreshold = DEFAULT_WORKER_ERROR_THRESHOLD,
      bedrockErrorThreshold = DEFAULT_BEDROCK_ERROR_THRESHOLD,
      ...stackProps
    } = props;

    super(scope, id, stackProps);

    assertPositiveInteger(
      "oldestMessageAgeSeconds",
      oldestMessageAgeSeconds,
    );
    assertPositiveInteger("workerErrorThreshold", workerErrorThreshold);
    assertPositiveInteger("bedrockErrorThreshold", bedrockErrorThreshold);

    this.apiLogGroup = new logs.LogGroup(this, "ApiLogGroup", {
      logGroupName: "/ai-statement-analyzer/api",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.workerLogGroup = new logs.LogGroup(this, "WorkerLogGroup", {
      logGroupName: "/ai-statement-analyzer/worker",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const workerErrorFilter = new logs.MetricFilter(
      this,
      "WorkerErrorMetricFilter",
      {
        logGroup: this.workerLogGroup,
        filterPattern: logs.FilterPattern.literal(
          '{ $.event = "worker_receive_failed" || $.event = "worker_job_failed" || $.event = "worker_delete_failed" }',
        ),
        metricNamespace: METRIC_NAMESPACE,
        metricName: "WorkerErrorCount",
        metricValue: "1",
        defaultValue: 0,
      },
    );

    const bedrockFilterPattern = logs.FilterPattern.literal(
      '{ $.event = "bedrock_request_failed" || $.event = "bedrock_response_invalid" }',
    );
    new logs.MetricFilter(this, "ApiBedrockErrorMetricFilter", {
      logGroup: this.apiLogGroup,
      filterPattern: bedrockFilterPattern,
      metricNamespace: METRIC_NAMESPACE,
      metricName: "BedrockErrorCount",
      metricValue: "1",
      defaultValue: 0,
    });
    new logs.MetricFilter(this, "WorkerBedrockErrorMetricFilter", {
      logGroup: this.workerLogGroup,
      filterPattern: bedrockFilterPattern,
      metricNamespace: METRIC_NAMESPACE,
      metricName: "BedrockErrorCount",
      metricValue: "1",
      defaultValue: 0,
    });

    const analyzeOldestMessageAlarm = new cloudwatch.Alarm(
      this,
      "AnalyzeOldestMessageAlarm",
      {
        alarmName: "ai-statement-analyzer-analyze-oldest-message",
        metric: analyzeQueue.metricApproximateAgeOfOldestMessage({
          period: cdk.Duration.minutes(1),
          statistic: "Maximum",
        }),
        threshold: oldestMessageAgeSeconds,
        evaluationPeriods: 5,
        datapointsToAlarm: 5,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      },
    );

    const workerErrorAlarm = new cloudwatch.Alarm(this, "WorkerErrorAlarm", {
      alarmName: "ai-statement-analyzer-worker-errors",
      metric: workerErrorFilter.metric({
        period: cdk.Duration.minutes(5),
        statistic: "Sum",
      }),
      threshold: workerErrorThreshold,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });

    const bedrockErrorMetric = new cloudwatch.Metric({
      namespace: METRIC_NAMESPACE,
      metricName: "BedrockErrorCount",
      period: cdk.Duration.minutes(5),
      statistic: "Sum",
    });
    const bedrockErrorAlarm = new cloudwatch.Alarm(
      this,
      "BedrockErrorAlarm",
      {
        alarmName: "ai-statement-analyzer-bedrock-errors",
        metric: bedrockErrorMetric,
        threshold: bedrockErrorThreshold,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      },
    );

    for (const alarm of [
      analyzeOldestMessageAlarm,
      workerErrorAlarm,
      bedrockErrorAlarm,
    ]) {
      alarm.addAlarmAction(new cloudwatchActions.SnsAction(alertsTopic));
    }

    new cdk.CfnOutput(this, "ApiLogGroupName", {
      value: this.apiLogGroup.logGroupName,
      description: "APIのStructured Logを保存するCloudWatch Log Group",
    });
    new cdk.CfnOutput(this, "WorkerLogGroupName", {
      value: this.workerLogGroup.logGroupName,
      description: "WorkerのStructured Logを保存するCloudWatch Log Group",
    });
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}
