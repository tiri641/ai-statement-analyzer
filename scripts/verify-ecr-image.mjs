import { spawnSync } from "node:child_process";

const imageTag = process.env.ECR_IMAGE_TAG?.trim();
if (!imageTag) {
  console.error("ECR_IMAGE_TAG must be set before deploying ApplicationStack");
  process.exit(1);
}

const region =
  process.env.AWS_REGION ?? process.env.CDK_DEFAULT_REGION ?? "ap-northeast-1";
const result = spawnSync(
  "aws",
  [
    "ecr",
    "describe-images",
    "--repository-name",
    "ai-statement-analyzer",
    "--image-ids",
    `imageTag=${imageTag}`,
    "--region",
    region,
  ],
  { stdio: "inherit" },
);

if (result.error) {
  console.error(`Failed to run AWS CLI: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
