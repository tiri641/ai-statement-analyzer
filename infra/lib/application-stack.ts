import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

const DEFAULT_API_DESIRED_COUNT = 0;
const DEFAULT_WORKER_DESIRED_COUNT = 0;
const DEFAULT_OCR_MODEL_ID = "jp.amazon.nova-2-lite-v1:0";
const DEFAULT_PROCESSING_LEASE_SECONDS = 600;
const DEFAULT_DATABASE_NAME = "statement_analyzer";
const DEFAULT_JP_NOVA_2_LITE_MODEL_ID = "jp.amazon.nova-2-lite-v1:0";
const DEFAULT_NOVA_2_LITE_FOUNDATION_MODEL_ARN_SUFFIX =
  "foundation-model/amazon.nova-2-lite-v1:0";

export interface ApplicationStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  albSecurityGroup: ec2.ISecurityGroup;
  apiSecurityGroup: ec2.ISecurityGroup;
  workerSecurityGroup: ec2.ISecurityGroup;
  database: rds.IDatabaseInstance;
  databaseSecret: secretsmanager.ISecret;
  repository: ecr.IRepository;
  statementBucket: s3.IBucket;
  analyzeQueue: sqs.IQueue;
  apiLogGroup: logs.ILogGroup;
  workerLogGroup: logs.ILogGroup;
  imageTag: string;
  frontendOrigin?: string;
  certificateArn?: string;
  apiDesiredCount?: number;
  workerDesiredCount?: number;
  ocrModelId?: string;
  ocrFoundationModelArns?: string[];
  insightsModelId?: string;
  insightsFoundationModelArns?: string[];
  processingLeaseSeconds?: number;
}

export class ApplicationStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly apiTaskDefinition: ecs.FargateTaskDefinition;
  public readonly workerTaskDefinition: ecs.FargateTaskDefinition;
  public readonly migrationTaskDefinition: ecs.FargateTaskDefinition;
  public readonly apiService: ecs.FargateService;
  public readonly workerService: ecs.FargateService;
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;

  public constructor(
    scope: Construct,
    id: string,
    props: ApplicationStackProps,
  ) {
    const {
      vpc,
      albSecurityGroup,
      apiSecurityGroup,
      workerSecurityGroup,
      database,
      databaseSecret,
      repository,
      statementBucket,
      analyzeQueue,
      apiLogGroup,
      workerLogGroup,
      imageTag,
      frontendOrigin,
      certificateArn,
      apiDesiredCount = DEFAULT_API_DESIRED_COUNT,
      workerDesiredCount = DEFAULT_WORKER_DESIRED_COUNT,
      ocrModelId = DEFAULT_OCR_MODEL_ID,
      ocrFoundationModelArns = [],
      insightsModelId,
      insightsFoundationModelArns = [],
      processingLeaseSeconds = DEFAULT_PROCESSING_LEASE_SECONDS,
      ...stackProps
    } = props;

    super(scope, id, stackProps);

    assertNonEmpty("imageTag", imageTag);
    assertNonNegativeInteger("apiDesiredCount", apiDesiredCount);
    assertNonNegativeInteger("workerDesiredCount", workerDesiredCount);
    assertPositiveInteger("processingLeaseSeconds", processingLeaseSeconds);

    const workerBedrockResources = modelPolicyResources(
      ocrModelId,
      ocrFoundationModelArns,
    );

    const executionRole = new iam.Role(this, "EcsExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "ECS agent role for image pull, logs, and secret injection",
    });
    repository.grantPull(executionRole);
    apiLogGroup.grantWrite(executionRole);
    workerLogGroup.grantWrite(executionRole);
    databaseSecret.grantRead(executionRole);

    const apiTaskRole = new iam.Role(this, "ApiTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "Least privilege role for the ECS API task",
    });
    const workerTaskRole = new iam.Role(this, "WorkerTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "Least privilege role for the ECS Worker task",
    });

    const statementObjectArn = statementBucket.arnForObjects("statements/*");
    apiTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject", "s3:GetObject"],
        resources: [statementObjectArn],
      }),
    );
    apiTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sqs:SendMessage"],
        resources: [analyzeQueue.queueArn],
      }),
    );
    workerTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage"],
        resources: [analyzeQueue.queueArn],
      }),
    );
    workerTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [statementObjectArn],
      }),
    );
    if (insightsModelId) {
      apiTaskRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ["bedrock:InvokeModel"],
          resources: modelPolicyResources(
            insightsModelId,
            insightsFoundationModelArns,
          ),
        }),
      );
    }
    workerTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: workerBedrockResources,
      }),
    );

    this.cluster = new ecs.Cluster(this, "ApplicationCluster", {
      vpc: vpc as unknown as ec2.IVpc,
    });

    const commonEnvironment = {
      APP_ENV: "aws-learning",
      AWS_REGION: cdk.Aws.REGION,
      DB_HOST: database.instanceEndpoint.hostname,
      DB_PORT: String(database.instanceEndpoint.port),
      DB_NAME: DEFAULT_DATABASE_NAME,
      DB_SSL: "true",
      S3_BUCKET_NAME: statementBucket.bucketName,
      SQS_QUEUE_URL: analyzeQueue.queueUrl,
      S3_PRESIGNED_URL_EXPIRES_SECONDS: "300",
      PROCESSING_LEASE_SECONDS: String(processingLeaseSeconds),
    };
    const databaseSecrets = {
      DB_USER: ecs.Secret.fromSecretsManager(databaseSecret, "username"),
      DB_PASSWORD: ecs.Secret.fromSecretsManager(databaseSecret, "password"),
    };
    const image = ecs.ContainerImage.fromEcrRepository(repository, imageTag);

    this.apiTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      "ApiTaskDefinition",
      {
        cpu: 256,
        memoryLimitMiB: 512,
        executionRole,
        taskRole: apiTaskRole,
      },
    );
    const apiContainer = this.apiTaskDefinition.addContainer("ApiContainer", {
      image,
      command: ["node", "dist/server.js"],
      environment: {
        ...commonEnvironment,
        HOST: "0.0.0.0",
        ALLOW_NON_LOOPBACK_HOST: "true",
        PORT: "3000",
        BEDROCK_INSIGHTS_MODEL_ID: insightsModelId ?? "",
        ...(frontendOrigin ? { FRONTEND_ORIGIN: frontendOrigin } : {}),
      },
      secrets: databaseSecrets,
      logging: new ecs.AwsLogDriver({
        logGroup: apiLogGroup,
        streamPrefix: "api",
      }),
      stopTimeout: cdk.Duration.seconds(30),
      healthCheck: {
        command: [
          "CMD-SHELL",
          "node -e \"fetch('http://127.0.0.1:3000/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))\"",
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
    });
    apiContainer.addPortMappings({ containerPort: 3000 });

    this.workerTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      "WorkerTaskDefinition",
      {
        cpu: 256,
        memoryLimitMiB: 512,
        executionRole,
        taskRole: workerTaskRole,
      },
    );
    this.workerTaskDefinition.addContainer("WorkerContainer", {
      image,
      command: ["node", "dist/worker.js"],
      environment: {
        ...commonEnvironment,
        BEDROCK_OCR_MODEL_ID: ocrModelId,
      },
      secrets: databaseSecrets,
      logging: new ecs.AwsLogDriver({
        logGroup: workerLogGroup,
        streamPrefix: "worker",
      }),
      stopTimeout: cdk.Duration.seconds(30),
    });

    this.migrationTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      "MigrationTaskDefinition",
      {
        cpu: 256,
        memoryLimitMiB: 512,
        executionRole,
      },
    );
    this.migrationTaskDefinition.addContainer("MigrationContainer", {
      image,
      command: ["node", "dist/migrate.js"],
      environment: commonEnvironment,
      secrets: databaseSecrets,
      logging: new ecs.AwsLogDriver({
        logGroup: apiLogGroup,
        streamPrefix: "migration",
      }),
      stopTimeout: cdk.Duration.seconds(30),
    });

    this.apiService = new ecs.FargateService(this, "ApiService", {
      cluster: this.cluster as unknown as ecs.ICluster,
      taskDefinition: this.apiTaskDefinition,
      desiredCount: apiDesiredCount,
      assignPublicIp: false,
      securityGroups: [apiSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      healthCheckGracePeriod: cdk.Duration.seconds(60),
    });
    this.workerService = new ecs.FargateService(this, "WorkerService", {
      cluster: this.cluster as unknown as ecs.ICluster,
      taskDefinition: this.workerTaskDefinition,
      desiredCount: workerDesiredCount,
      assignPublicIp: false,
      securityGroups: [workerSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
    });

    this.loadBalancer = new elbv2.ApplicationLoadBalancer(
      this,
      "InternalApplicationLoadBalancer",
      {
        vpc: vpc as unknown as ec2.IVpc,
        internetFacing: false,
        securityGroup: albSecurityGroup,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      },
    );

    const httpListener = this.loadBalancer.addListener("HttpListener", {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
    });

    if (certificateArn) {
      const httpsListener = this.loadBalancer.addListener("HttpsListener", {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [elbv2.ListenerCertificate.fromArn(certificateArn)],
        open: false,
      });
      httpsListener.addTargets("HttpsApiTarget", {
        port: 3000,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [this.apiService],
        healthCheck: apiHealthCheck(),
      });
      httpListener.addAction(
        "RedirectToHttps",
        {
          action: elbv2.ListenerAction.redirect({
            protocol: "HTTPS",
            port: "443",
            permanent: true,
          }),
        },
      );
    } else {
      httpListener.addTargets("HttpApiTarget", {
        port: 3000,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [this.apiService],
        healthCheck: apiHealthCheck(),
      });
    }

    new cdk.CfnOutput(this, "InternalAlbDnsName", {
      value: this.loadBalancer.loadBalancerDnsName,
      description: "Internal ALB DNS name for VPC-only API access",
    });
    new cdk.CfnOutput(this, "ClusterName", {
      value: this.cluster.clusterName,
      description: "ECS cluster for API, Worker, and migration tasks",
    });
    new cdk.CfnOutput(this, "MigrationTaskDefinitionArn", {
      value: this.migrationTaskDefinition.taskDefinitionArn,
      description: "One-off ECS task definition for schema migration",
    });
    new cdk.CfnOutput(this, "ApiTaskDefinitionArn", {
      value: this.apiTaskDefinition.taskDefinitionArn,
      description: "ECS task definition for temporary API validation tasks",
    });
    new cdk.CfnOutput(this, "WorkerTaskDefinitionArn", {
      value: this.workerTaskDefinition.taskDefinitionArn,
      description: "ECS task definition for temporary Worker validation tasks",
    });
    new cdk.CfnOutput(this, "ApiServiceName", {
      value: this.apiService.serviceName,
      description: "ECS API service name",
    });
    new cdk.CfnOutput(this, "WorkerServiceName", {
      value: this.workerService.serviceName,
      description: "ECS Worker service name",
    });
  }
}

function apiHealthCheck(): elbv2.HealthCheck {
  return {
    path: "/health",
    healthyHttpCodes: "200",
    interval: cdk.Duration.seconds(30),
    timeout: cdk.Duration.seconds(5),
    healthyThresholdCount: 2,
    unhealthyThresholdCount: 3,
  };
}

function modelPolicyResources(
  modelId: string,
  explicitFoundationModelArns: string[],
): string[] {
  if (modelId.startsWith("arn:")) {
    if (isInferenceProfileArn(modelId)) {
      return [
        modelId,
        ...requireFoundationModelArns(modelId, explicitFoundationModelArns),
      ];
    }

    return [modelId];
  }

  if (isInferenceProfileId(modelId)) {
    const profileArn = `arn:${cdk.Aws.PARTITION}:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:inference-profile/${modelId}`;
    const foundationModelArns =
      modelId === DEFAULT_JP_NOVA_2_LITE_MODEL_ID
        ? defaultJpNova2LiteFoundationModelArns()
        : requireFoundationModelArns(modelId, explicitFoundationModelArns);

    return [profileArn, ...foundationModelArns];
  }

  return [
    `arn:${cdk.Aws.PARTITION}:bedrock:${cdk.Aws.REGION}::foundation-model/${modelId}`,
  ];
}

function isInferenceProfileId(modelId: string): boolean {
  return ["us.", "eu.", "apac.", "jp.", "global."].some((prefix) =>
    modelId.startsWith(prefix),
  );
}

function isInferenceProfileArn(modelArnValue: string): boolean {
  return (
    modelArnValue.includes(":inference-profile/") ||
    modelArnValue.includes(":application-inference-profile/")
  );
}

function requireFoundationModelArns(
  modelId: string,
  foundationModelArns: string[],
): string[] {
  if (foundationModelArns.length === 0) {
    throw new Error(
      `${modelId} requires the Foundation Model ARNs used by its inference profile`,
    );
  }

  return foundationModelArns;
}

function defaultJpNova2LiteFoundationModelArns(): string[] {
  return [
    `arn:${cdk.Aws.PARTITION}:bedrock:ap-northeast-1::${DEFAULT_NOVA_2_LITE_FOUNDATION_MODEL_ARN_SUFFIX}`,
    `arn:${cdk.Aws.PARTITION}:bedrock:ap-northeast-3::${DEFAULT_NOVA_2_LITE_FOUNDATION_MODEL_ARN_SUFFIX}`,
  ];
}

function assertNonEmpty(name: string, value: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${name} must not be empty`);
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}
