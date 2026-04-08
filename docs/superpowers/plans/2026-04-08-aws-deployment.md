# AWS Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy agent-brain on a single EC2 instance (~$8/mo) for a 12-person team using Terraform and Docker Compose.

**Architecture:** Single `t4g.micro` EC2 in an existing private VPC runs Postgres + agent-brain via Docker Compose. Titan embeddings via Bedrock (no Ollama). Docker image built locally and pushed to ECR. Terraform module in `iac/modules/agent-brain/`, environment config in `iac/envs/dev/`.

**Tech Stack:** Terraform, Docker Compose, Amazon Linux 2023, cloud-init, AWS ECR, AWS Bedrock (Titan embeddings)

---

## File Structure

### New Files

```
iac/
  modules/
    agent-brain/
      main.tf                      # ECR repo, EC2 instance, security group, IAM role/instance profile
      variables.tf                 # Module inputs (vpc_id, subnet_id, etc.)
      outputs.tf                   # Module outputs (private_ip, instance_id, ecr_repository_url)
      cloud-init.yml.tftpl         # Cloud-init template (installs Docker, writes compose + env, starts stack)
  envs/
    dev/
      main.tf                      # Calls agent-brain module with dev values
      variables.tf                 # Environment-level variable declarations
      backend.tf                   # Terraform state backend config (local)
      terraform.tfvars.example     # Example tfvars for onboarding
  README.md                        # Deploy instructions
```

### Modified Files

```
.gitignore                         # Add Terraform patterns
```

---

### Task 1: Terraform Module — variables.tf and outputs.tf

**Files:**

- Create: `iac/modules/agent-brain/variables.tf`
- Create: `iac/modules/agent-brain/outputs.tf`

- [ ] **Step 1: Create iac/modules/agent-brain/variables.tf**

```hcl
variable "vpc_id" {
  description = "ID of the existing VPC to deploy into"
  type        = string
}

variable "subnet_id" {
  description = "ID of the private subnet for the EC2 instance"
  type        = string
}

variable "project_id" {
  description = "agent-brain PROJECT_ID — identifies this deployment"
  type        = string
}

variable "aws_region" {
  description = "AWS region for Bedrock Titan embeddings"
  type        = string
  default     = "us-east-1"
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t4g.micro"
}

variable "key_name" {
  description = "SSH key pair name for instance access (optional)"
  type        = string
  default     = null
}
```

- [ ] **Step 2: Create iac/modules/agent-brain/outputs.tf**

```hcl
output "private_ip" {
  description = "Private IP address of the agent-brain instance"
  value       = aws_instance.agent_brain.private_ip
}

output "instance_id" {
  description = "EC2 instance ID"
  value       = aws_instance.agent_brain.id
}

output "ecr_repository_url" {
  description = "ECR repository URL for agent-brain images"
  value       = aws_ecr_repository.agent_brain.repository_url
}
```

- [ ] **Step 3: Commit**

```bash
git add iac/modules/agent-brain/variables.tf iac/modules/agent-brain/outputs.tf
git commit -m "feat: add Terraform module variables and outputs for agent-brain"
```

---

### Task 2: Terraform Module — cloud-init Template

**Files:**

- Create: `iac/modules/agent-brain/cloud-init.yml.tftpl`

The cloud-init template installs Docker, writes the compose file and init SQL inline, pulls the pre-built image from ECR, and starts the stack. Uses Terraform's `templatefile()` to inject variables.

The compose file is embedded directly in cloud-init rather than copied from the repo. This means the instance is self-contained — no git clone, no deploy keys.

DB migrations run via an entrypoint wrapper: the cloud-init writes a `start.sh` script that runs `npx drizzle-kit migrate` then starts the app. This avoids the chicken-and-egg problem of needing the app healthy to exec into it.

- [ ] **Step 1: Create iac/modules/agent-brain/cloud-init.yml.tftpl**

```yaml
#cloud-config
package_update: true

packages:
  - docker

write_files:
  - path: /opt/agent-brain/docker-compose.yml
    permissions: "0644"
    content: |
      services:
        postgres:
          image: pgvector/pgvector:pg17
          restart: unless-stopped
          environment:
            POSTGRES_USER: agentic
            POSTGRES_PASSWORD: agentic
            POSTGRES_DB: agent_brain
          volumes:
            - pgdata:/var/lib/postgresql/data
            - ./init-extensions.sql:/docker-entrypoint-initdb.d/01-extensions.sql
          healthcheck:
            test: ["CMD-SHELL", "pg_isready -U agentic -d agent_brain"]
            interval: 5s
            timeout: 5s
            retries: 5

        agent-brain:
          image: ${ecr_image}
          restart: unless-stopped
          ports:
            - "19898:19898"
          environment:
            PROJECT_ID: "${project_id}"
            DATABASE_URL: postgres://agentic:agentic@postgres:5432/agent_brain
            EMBEDDING_PROVIDER: titan
            AWS_REGION: "${aws_region}"
            HOST: 0.0.0.0
            PORT: "19898"
          entrypoint: ["/bin/sh", "-c", "npx drizzle-kit migrate && npx tsx src/server.ts"]
          depends_on:
            postgres:
              condition: service_healthy
          healthcheck:
            test: ["CMD", "curl", "-sf", "http://localhost:19898/health"]
            interval: 5s
            timeout: 5s
            retries: 5

      volumes:
        pgdata:

  - path: /opt/agent-brain/init-extensions.sql
    permissions: "0644"
    content: |
      CREATE EXTENSION IF NOT EXISTS vector;

runcmd:
  - systemctl enable docker
  - systemctl start docker
  - |
    mkdir -p /usr/local/lib/docker/cli-plugins
    ARCH=$(uname -m)
    curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$${ARCH}" \
      -o /usr/local/lib/docker/cli-plugins/docker-compose
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
  - |
    aws ecr get-login-password --region ${aws_region} \
      | docker login --username AWS --password-stdin ${ecr_url}
  - cd /opt/agent-brain && docker compose up -d
```

- [ ] **Step 2: Commit**

```bash
git add iac/modules/agent-brain/cloud-init.yml.tftpl
git commit -m "feat: add cloud-init template for EC2 bootstrap"
```

---

### Task 3: Terraform Module — main.tf

**Files:**

- Create: `iac/modules/agent-brain/main.tf`

This is the core of the module: ECR repo, security group, IAM role, and EC2 instance.

- [ ] **Step 1: Create iac/modules/agent-brain/main.tf**

```hcl
terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# --- ECR Repository ---

resource "aws_ecr_repository" "agent_brain" {
  name                 = "agent-brain"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
}

# --- Data Sources ---

data "aws_vpc" "selected" {
  id = var.vpc_id
}

data "aws_ssm_parameter" "al2023_arm" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

# --- Security Group ---

resource "aws_security_group" "agent_brain" {
  name_prefix = "agent-brain-"
  description = "Allow agent-brain traffic from VPC"
  vpc_id      = var.vpc_id

  ingress {
    description = "agent-brain MCP"
    from_port   = 19898
    to_port     = 19898
    protocol    = "tcp"
    cidr_blocks = [data.aws_vpc.selected.cidr_block]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# --- IAM Role ---

resource "aws_iam_role" "agent_brain" {
  name_prefix = "agent-brain-"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy" "bedrock" {
  name_prefix = "bedrock-"
  role        = aws_iam_role.agent_brain.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "bedrock:InvokeModel"
      Resource = "arn:aws:bedrock:${var.aws_region}::foundation-model/amazon.titan-embed-text-v2:0"
    }]
  })
}

resource "aws_iam_role_policy" "ecr_pull" {
  name_prefix = "ecr-pull-"
  role        = aws_iam_role.agent_brain.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:GetAuthorizationToken"
      ]
      Resource = "*"
    }]
  })
}

resource "aws_iam_instance_profile" "agent_brain" {
  name_prefix = "agent-brain-"
  role        = aws_iam_role.agent_brain.name
}

# --- EC2 Instance ---

resource "aws_instance" "agent_brain" {
  ami                    = data.aws_ssm_parameter.al2023_arm.value
  instance_type          = var.instance_type
  subnet_id              = var.subnet_id
  vpc_security_group_ids = [aws_security_group.agent_brain.id]
  iam_instance_profile   = aws_iam_instance_profile.agent_brain.name
  key_name               = var.key_name

  root_block_device {
    volume_size = 10
    volume_type = "gp3"
  }

  user_data = templatefile("${path.module}/cloud-init.yml.tftpl", {
    project_id = var.project_id
    aws_region = var.aws_region
    ecr_url    = split("/", aws_ecr_repository.agent_brain.repository_url)[0]
    ecr_image  = "${aws_ecr_repository.agent_brain.repository_url}:latest"
  })

  tags = {
    Name = "agent-brain"
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add iac/modules/agent-brain/main.tf
git commit -m "feat: add Terraform module main.tf — EC2, SG, IAM, ECR"
```

---

### Task 4: Terraform Environment — iac/envs/dev/

**Files:**

- Create: `iac/envs/dev/main.tf`
- Create: `iac/envs/dev/variables.tf`
- Create: `iac/envs/dev/backend.tf`

- [ ] **Step 1: Create iac/envs/dev/variables.tf**

```hcl
variable "vpc_id" {
  description = "VPC ID to deploy into"
  type        = string
}

variable "subnet_id" {
  description = "Private subnet ID"
  type        = string
}

variable "project_id" {
  description = "agent-brain PROJECT_ID"
  type        = string
  default     = "agent-brain-dev"
}

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t4g.micro"
}

variable "key_name" {
  description = "SSH key pair name (optional)"
  type        = string
  default     = null
}
```

- [ ] **Step 2: Create iac/envs/dev/backend.tf**

```hcl
terraform {
  backend "local" {
    path = "terraform.tfstate"
  }
}
```

- [ ] **Step 3: Create iac/envs/dev/main.tf**

```hcl
terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

module "agent_brain" {
  source = "../../modules/agent-brain"

  vpc_id        = var.vpc_id
  subnet_id     = var.subnet_id
  project_id    = var.project_id
  aws_region    = var.aws_region
  instance_type = var.instance_type
  key_name      = var.key_name
}

output "private_ip" {
  value = module.agent_brain.private_ip
}

output "instance_id" {
  value = module.agent_brain.instance_id
}

output "ecr_repository_url" {
  description = "ECR repo URL — push images here before first deploy"
  value       = module.agent_brain.ecr_repository_url
}
```

- [ ] **Step 4: Commit**

```bash
git add iac/envs/dev/main.tf iac/envs/dev/variables.tf iac/envs/dev/backend.tf
git commit -m "feat: add Terraform dev environment config"
```

---

### Task 5: Gitignore and tfvars Example

**Files:**

- Modify: `.gitignore`
- Create: `iac/envs/dev/terraform.tfvars.example`

- [ ] **Step 1: Read the current .gitignore**

```bash
cat .gitignore
```

- [ ] **Step 2: Append Terraform patterns to .gitignore**

Add the following lines to the end of `.gitignore`:

```
# Terraform
**/.terraform/
*.tfstate
*.tfstate.*
*.tfvars
!*.tfvars.example
```

- [ ] **Step 3: Create iac/envs/dev/terraform.tfvars.example**

```hcl
vpc_id    = "vpc-xxxxxxxxx"
subnet_id = "subnet-xxxxxxxxx"
# project_id    = "agent-brain-dev"
# aws_region    = "us-east-1"
# instance_type = "t4g.micro"
# key_name      = "my-key"
```

- [ ] **Step 4: Commit**

```bash
git add .gitignore iac/envs/dev/terraform.tfvars.example
git commit -m "chore: add Terraform patterns to .gitignore and tfvars example"
```

---

### Task 6: Validate Terraform and Write Deploy Instructions

**Files:**

- Create: `iac/README.md`

- [ ] **Step 1: Validate Terraform initializes**

```bash
cd iac/envs/dev
terraform init
```

Expected: "Terraform has been successfully initialized!"

- [ ] **Step 2: Create iac/README.md**

````markdown
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
````

2. Deploy infrastructure (creates ECR repo, EC2 instance, etc.):

   ```bash
   terraform init
   terraform apply
   ```

3. Build and push the Docker image to ECR:

   ```bash
   # Get the ECR repo URL from Terraform output
   ECR_URL=$(terraform output -raw ecr_repository_url)

   # Login to ECR
   aws ecr get-login-password --region us-east-1 \
     | docker login --username AWS --password-stdin $(echo $ECR_URL | cut -d/ -f1)

   # Build for ARM (t4g instances are ARM-based)
   cd ../../..
   docker buildx build --platform linux/arm64 -t $ECR_URL:latest --push .
   ```

4. SSH into the instance and verify:

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

# SSH in and pull + restart
INSTANCE_ID=$(cd iac/envs/dev && terraform output -raw instance_id)
aws ssm start-session --target $INSTANCE_ID
# On the instance:
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

````

- [ ] **Step 3: Commit**

```bash
git add iac/README.md
git commit -m "docs: add deployment instructions for AWS setup"
````
