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
