import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as sqs from "aws-cdk-lib/aws-sqs";

export class MessagingStack extends cdk.Stack {
  public readonly analyzeQueue: sqs.Queue;
  public readonly analyzeDlq: sqs.Queue;

  public constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, {
      ...props,
      // このStackはSQSリソースだけを管理し、アプリケーションのAssetを持たない。
      // 学習用アカウントでCDK bootstrapの実行RoleにSSM全体の参照権限を
      // 追加しなくてもデプロイできるよう、bootstrap version ruleを使わない。
      synthesizer:
        props?.synthesizer ??
        (new cdk.DefaultStackSynthesizer({
          generateBootstrapVersionRule: false,
        }) as unknown as cdk.IStackSynthesizer),
    });

    this.analyzeDlq = new sqs.Queue(this, "AnalyzeDlq", {
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      // CDK生成名のQueue ARNをsource queueへ渡すとStack内で循環参照になり得るため、
      // Phase 5ではALLOW_ALLを明示する。これはIAM認可とは別の設定であり、
      // 任意のQueueに広く許可する点は既知の制限としてPhase 13で再検討する。
      redriveAllowPolicy: {
        redrivePermission: sqs.RedrivePermission.ALLOW_ALL,
      },
    });

    this.analyzeQueue = new sqs.Queue(this, "AnalyzeQueue", {
      retentionPeriod: cdk.Duration.days(4),
      visibilityTimeout: cdk.Duration.seconds(300),
      receiveMessageWaitTime: cdk.Duration.seconds(20),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deadLetterQueue: {
        queue: this.analyzeDlq,
        maxReceiveCount: 3,
      },
    });

    new cdk.CfnOutput(this, "AnalyzeQueueUrl", {
      value: this.analyzeQueue.queueUrl,
      description: "解析ジョブを送信するSQS Standard QueueのURL",
    });
    new cdk.CfnOutput(this, "AnalyzeQueueArn", {
      value: this.analyzeQueue.queueArn,
      description: "解析ジョブを送信するSQS Standard QueueのARN",
    });
    new cdk.CfnOutput(this, "AnalyzeDlqUrl", {
      value: this.analyzeDlq.queueUrl,
      description: "解析ジョブのDead Letter QueueのURL",
    });
    new cdk.CfnOutput(this, "AnalyzeDlqArn", {
      value: this.analyzeDlq.queueArn,
      description: "解析ジョブのDead Letter QueueのARN",
    });
  }
}
