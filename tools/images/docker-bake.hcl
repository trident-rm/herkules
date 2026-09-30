# The release images as one BuildKit graph (.github/workflows/image-build.yml). Building the
# selected targets together shares the `build` and AI stages between them instead of each
# runner rebuilding them. Paths resolve from the working directory: run from the repo root.
#   docker buildx bake -f tools/images/docker-bake.hcl --print auth bbs

variable "REPOSITORY" {
  default = "trident-rm/herkules"
}

variable "SHORT_SHA" {
  default = "local"
}

# Filled in CI by docker/metadata-action (OCI labels); empty locally.
target "docker-metadata-action" {}

group "default" {
  targets = ["auth", "bbs", "bbs-web", "ai", "platform"]
}

target "image" {
  matrix = {
    image = ["auth", "bbs", "bbs-web", "ai", "platform"]
  }
  name       = image
  inherits   = ["docker-metadata-action"]
  context    = "."
  dockerfile = "Dockerfile"
  target     = image
  platforms  = ["linux/amd64"]
  tags = [
    "ghcr.io/${REPOSITORY}/${image}:latest",
    "ghcr.io/${REPOSITORY}/${image}:sha-${SHORT_SHA}",
  ]
  # ai-backend is written by ci.yml's new-api job.
  cache-from = [for scope in ["auth", "bbs", "bbs-web", "platform", "ai-backend", "ai"] : "type=gha,scope=${scope}"]
  # One scope per image: concurrent exports to a single GHA scope overwrite each other.
  cache-to = ["type=gha,scope=${image},mode=max"]
}
