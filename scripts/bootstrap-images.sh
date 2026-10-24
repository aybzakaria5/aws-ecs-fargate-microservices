#!/usr/bin/env bash
# One-time bootstrap: push the first image of every service (tag "bootstrap") so that Terraform can
# create ECS services whose task definitions point at an image that exists.
# After this, GitHub Actions pushes commit-SHA tags and rolls the services.
#
# Requires: AWS credentials in the environment, Docker, and the ECR repositories (step 1 in infra/README.md).
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
NAME="${NAME_PREFIX:-msvc-demo}"           # <project>-<environment>
TAG="${IMAGE_TAG:-bootstrap}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"

for svc in auth orders notifications; do
  image="${REGISTRY}/${NAME}/${svc}:${TAG}"
  echo ">> building and pushing ${image}"
  # Fargate tasks are defined as X86_64; --platform keeps this working when built on an ARM laptop (Apple Silicon)
  docker build --platform linux/amd64 -t "$image" "services/${svc}"
  docker push "$image"
done
