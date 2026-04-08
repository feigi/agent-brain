# AWS Deployment Design — agent-brain

## Goal

Deploy agent-brain for a team of 12 on AWS as cheaply as possible (~$8/mo). Single EC2 instance running Docker Compose with Postgres and the app. Titan embeddings instead of self-hosted Ollama. Terraform for IaC, executed locally.

## Constraints

- Private VPC already exists and is reachable from company network
- No CI/CD — deploy from laptop via Terraform, update via SSH
- No backups for now
- Shared memory pool (single `PROJECT_ID`) for all 12 users
- No TLS or auth layer needed (private network)

## Architecture

```
┌─────────────────────────────────────────────┐
│  EC2 t4g.micro (ARM, 2 vCPU, 1GB)          │
│  Amazon Linux 2023 · EBS gp3 10GB           │
│                                             │
│  ┌──────────────┐  ┌─────────────────────┐  │
│  │  Postgres 17  │  │   agent-brain app   │  │
│  │  + pgvector   │◄─┤   (Node.js / tsx)   │  │
│  │  :5432        │  │   :19898            │  │
│  └──────────────┘  └────────┬────────────┘  │
│                             │               │
└─────────────────────────────┼───────────────┘
                              │
                    ┌─────────▼─────────┐
                    │  AWS Bedrock       │
                    │  Titan Embeddings  │
                    └───────────────────┘
```

### Networking

- Security group: inbound TCP 19898 from VPC CIDR, outbound all
- No public IP, no load balancer
- Team connects directly to the instance's private IP on port 19898

### IAM

- Instance profile with a role that allows `bedrock:InvokeModel` for Titan embedding models
- No other AWS API access needed

### Instance Bootstrap (cloud-init)

Runs once on first launch:

1. Install Docker + Docker Compose plugin via `dnf`
2. Write compose file and `.env` to `/opt/agent-brain/`
3. `systemctl enable docker`
4. `docker compose up -d`
5. Run DB migrations (`drizzle-kit migrate` inside the app container)

On reboot, Docker's `restart: unless-stopped` policy brings containers back automatically.

### Updates

SSH into the instance, rebuild and restart:

```bash
cd /opt/agent-brain
# Update compose file or .env as needed
docker compose up -d --build
```

## Docker Compose (deploy)

A new `docker-compose.deploy.yml` at the project root. Standalone — does not include the dev compose files. Contains only:

**postgres** — `pgvector/pgvector:pg17`, named volume for data, healthcheck.

**agent-brain** — builds from existing Dockerfile, depends on Postgres healthy. Environment:

- `EMBEDDING_PROVIDER=titan`
- `AWS_REGION` from env
- `DATABASE_URL=postgres://agentic:agentic@postgres:5432/agent_brain`
- `PROJECT_ID` from env
- `HOST=0.0.0.0`

No Ollama service or volumes.

## Terraform Structure

```
iac/
  modules/
    agent-brain/
      main.tf           # EC2 instance, security group, IAM role/instance profile
      variables.tf      # Module inputs
      outputs.tf        # Instance private IP, instance ID
      cloud-init.yml    # Cloud-init template (embedded compose + env)
  envs/
    dev/
      main.tf           # Calls agent-brain module with dev values
      variables.tf      # vpc_id, subnet_id, project_id, key_name, aws_region
      terraform.tfvars  # Actual values (gitignored)
      backend.tf        # State config (local or S3)
```

### Module Inputs

| Variable        | Type   | Default     | Description                   |
| --------------- | ------ | ----------- | ----------------------------- |
| `vpc_id`        | string | —           | Existing VPC ID               |
| `subnet_id`     | string | —           | Private subnet to deploy into |
| `project_id`    | string | —           | agent-brain PROJECT_ID        |
| `aws_region`    | string | `us-east-1` | AWS region for Bedrock        |
| `instance_type` | string | `t4g.micro` | EC2 instance type             |
| `key_name`      | string | `null`      | SSH key pair name (optional)  |

### Module Outputs

| Output        | Description                                          |
| ------------- | ---------------------------------------------------- |
| `private_ip`  | Instance private IP (what team points MCP config at) |
| `instance_id` | EC2 instance ID                                      |

## Cost Estimate

| Resource                                 | Monthly Cost |
| ---------------------------------------- | ------------ |
| EC2 t4g.micro (on-demand)                | ~$6          |
| EBS gp3 10GB                             | ~$1          |
| Titan embeddings (12 users, light usage) | ~$0.50       |
| **Total**                                | **~$8**      |

## What This Design Does Not Include

- TLS / HTTPS (private network, not needed)
- Authentication middleware (private network)
- Backups (deferred)
- CI/CD pipeline (deferred)
- High availability / auto-scaling (unnecessary for 12 users)
- Monitoring / alerting (can be added later)
