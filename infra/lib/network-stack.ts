import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";

export interface NetworkStackProps extends cdk.StackProps {
  vpcCidr?: string;
  natGateways?: number;
}

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly albSecurityGroup: ec2.SecurityGroup;
  public readonly apiSecurityGroup: ec2.SecurityGroup;
  public readonly workerSecurityGroup: ec2.SecurityGroup;
  public readonly databaseSecurityGroup: ec2.SecurityGroup;

  public constructor(
    scope: Construct,
    id: string,
    props: NetworkStackProps = {},
  ) {
    const {
      vpcCidr = "10.0.0.0/16",
      natGateways = 1,
      ...stackProps
    } = props;

    super(scope, id, stackProps);

    if (!Number.isInteger(natGateways) || natGateways < 1) {
      throw new Error("natGateways must be a positive integer");
    }

    this.vpc = new ec2.Vpc(this, "ApplicationVpc", {
      ipAddresses: ec2.IpAddresses.cidr(vpcCidr),
      maxAzs: 2,
      natGateways,
      restrictDefaultSecurityGroup: true,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: "Application",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          name: "Database",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    this.vpc.addGatewayEndpoint("S3GatewayEndpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
    });

    this.albSecurityGroup = new ec2.SecurityGroup(this, "AlbSecurityGroup", {
      vpc: this.vpc as unknown as ec2.IVpc,
      description: "Internal ALB security group",
      allowAllOutbound: true,
    });
    this.apiSecurityGroup = new ec2.SecurityGroup(this, "ApiSecurityGroup", {
      vpc: this.vpc as unknown as ec2.IVpc,
      description: "ECS API security group",
      allowAllOutbound: true,
    });
    this.workerSecurityGroup = new ec2.SecurityGroup(
      this,
      "WorkerSecurityGroup",
      {
        vpc: this.vpc as unknown as ec2.IVpc,
        description: "ECS Worker security group",
        allowAllOutbound: true,
      },
    );
    this.databaseSecurityGroup = new ec2.SecurityGroup(
      this,
      "DatabaseSecurityGroup",
      {
        vpc: this.vpc as unknown as ec2.IVpc,
        description: "Private RDS security group",
        allowAllOutbound: true,
      },
    );

    this.albSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcp(80),
      "Internal HTTP access",
    );
    this.albSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      "Internal HTTPS access",
    );
    this.apiSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      ec2.Port.tcp(3000),
      "ALB to API",
    );
    this.databaseSecurityGroup.addIngressRule(
      this.apiSecurityGroup,
      ec2.Port.tcp(5432),
      "API to PostgreSQL",
    );
    this.databaseSecurityGroup.addIngressRule(
      this.workerSecurityGroup,
      ec2.Port.tcp(5432),
      "Worker to PostgreSQL",
    );

    new cdk.CfnOutput(this, "VpcId", {
      value: this.vpc.vpcId,
      description: "Phase 13 application VPC ID",
    });
    new cdk.CfnOutput(this, "ApplicationSubnetIds", {
      value: cdk.Fn.join(
        ",",
        this.vpc
          .selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS })
          .subnets.map((subnet) => subnet.subnetId),
      ),
      description: "Private subnet IDs for ECS tasks and one-off migration",
    });
    new cdk.CfnOutput(this, "ApiSecurityGroupId", {
      value: this.apiSecurityGroup.securityGroupId,
      description: "Security group ID for ECS API tasks",
    });
    new cdk.CfnOutput(this, "WorkerSecurityGroupId", {
      value: this.workerSecurityGroup.securityGroupId,
      description: "Security group ID for ECS Worker tasks",
    });
  }
}
