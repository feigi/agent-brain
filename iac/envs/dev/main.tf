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
