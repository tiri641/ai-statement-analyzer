# Network

```text
Public Subnet: ALB
Private App Subnet: ECS API / ECS Worker
Private DB Subnet: RDS PostgreSQL
```

ECSから必要な通信先を洗い出す:

- S3: Gateway Endpoint候補
- ECR API / DKR: Interface EndpointまたはNAT
- SQS: Interface EndpointまたはNAT
- Bedrock Runtime: Interface EndpointまたはNAT
- CloudWatch Logs: Interface EndpointまたはNAT
- Secrets Manager: Interface EndpointまたはNAT

LearningはNAT 1台 + S3 Gateway Endpointを推奨。Production-likeは2 AZにNATを各1台、またはNAT禁止の要件があれば上記Interface Endpointを2 AZに置く。S3 Gateway Endpointはhourly / data processingなし、Interface Endpointはendpoint-hourとdata processingがある。

参照: [S3 gateway endpoint](https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints-s3.html)、[Bedrock interface endpoint](https://docs.aws.amazon.com/bedrock/latest/userguide/vpc-interface-endpoints.html)、[PrivateLink supported services](https://docs.aws.amazon.com/vpc/latest/privatelink/aws-services-privatelink-support.html)。

