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
