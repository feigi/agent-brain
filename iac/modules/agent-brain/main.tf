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
    Statement = [
      {
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage"
        ]
        Resource = aws_ecr_repository.agent_brain.arn
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.agent_brain.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
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
