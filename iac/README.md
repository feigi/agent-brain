# Deploying agent-brain

## Prerequisites

- Terraform >= 1.5
- AWS CLI configured with credentials
- Docker (for building and pushing the image)

## First-time Setup

1. Copy the tfvars example and fill in your values:

   ```bash
   cd iac/envs/dev
   cp terraform.tfvars.example terraform.tfvars
   # Edit terraform.tfvars with your VPC and subnet IDs
   ```

2. Deploy infrastructure (creates ECR repo, EC2 instance, etc.):

   ```bash
   terraform init
   terraform apply
   ```

3. Build and push the Docker image to ECR:

   ```bash
   # Get the ECR repo URL from Terraform output
   ECR_URL=$(terraform output -raw ecr_repository_url)

   # Login to ECR (replace region if not using us-east-1)
   aws ecr get-login-password --region us-east-1 \
     | docker login --username AWS --password-stdin $(echo $ECR_URL | cut -d/ -f1)

   # Build for ARM (t4g instances are ARM-based)
   cd ../../..
   docker buildx build --platform linux/arm64 -t $ECR_URL:latest --push .
   ```

4. Connect to the instance and verify:

   ```bash
   INSTANCE_ID=$(cd iac/envs/dev && terraform output -raw instance_id)
   aws ssm start-session --target $INSTANCE_ID
   # On the instance:
   cd /opt/agent-brain && docker compose logs -f
   ```

## Updating the Application

```bash
# From repo root
ECR_URL=$(cd iac/envs/dev && terraform output -raw ecr_repository_url)
docker buildx build --platform linux/arm64 -t $ECR_URL:latest --push .

# Connect via SSM and pull + restart
INSTANCE_ID=$(cd iac/envs/dev && terraform output -raw instance_id)
aws ssm start-session --target $INSTANCE_ID
# On the instance (replace region if not using us-east-1):
cd /opt/agent-brain
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin $(echo $ECR_URL | cut -d/ -f1)
docker compose pull && docker compose up -d
```

## Team MCP Configuration

Each team member points their Claude Code MCP config at:

```
http://<private_ip>:19898/mcp
```

Get the private IP: `cd iac/envs/dev && terraform output private_ip`
