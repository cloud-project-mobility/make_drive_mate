"""Deploy a verified code-only CI artifact to the existing single-task ECS API."""
from __future__ import annotations

import argparse
import base64
import copy
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import zipfile

from deploy_release import inspect_archive, revision_value

JAR = "backend-spring/target/drivemate-api-0.2.0.jar"
REGISTER_FIELDS = (
    "family", "taskRoleArn", "executionRoleArn", "networkMode", "containerDefinitions",
    "volumes", "placementConstraints", "requiresCompatibilities", "cpu", "memory",
    "pidMode", "ipcMode", "proxyConfiguration", "inferenceAccelerators",
    "ephemeralStorage", "runtimePlatform", "enableFaultInjection",
)
WAITER_CONFIG = {"Delay": 15, "MaxAttempts": 80}


def name_value(value, label):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,255}", value):
        raise ValueError("Configure a valid " + label + " name.")
    return value


def repository_value(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-z0-9]+(?:[._/-][a-z0-9]+)*", value) or len(value) > 256:
        raise ValueError("Configure a valid ECR repository name.")
    return value


def image_value(value):
    if not re.fullmatch(r"[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/[a-z0-9._/-]+@sha256:[a-f0-9]{64}", value):
        raise ValueError("Only a private ECR image pinned by SHA-256 is accepted.")
    return value


def stage_artifacts(repo, archive, revision, checksum):
    """Only tested web/JAR outputs are extracted; code comes from the same checkout."""
    manifest = inspect_archive(archive, revision, checksum)
    repo = Path(repo).resolve()
    selected = [name for name in manifest["files"] if name == JAR or name.startswith("dist/")]
    for name in selected:
        destination = repo / name
        if destination.exists() or any(parent.is_symlink() for parent in destination.parents):
            raise ValueError("Stage into a fresh checkout with no existing build outputs or links.")
    with zipfile.ZipFile(archive) as bundle:
        for name in selected:
            destination = repo / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open("xb") as output:
                output.write(bundle.read(name))
    return {"source_revision": revision, "staged_files": len(selected), "private_data_included": False}


def aws_client(service, region):
    import boto3
    from botocore.config import Config
    if not re.fullmatch(r"[a-z]{2}(?:-[a-z]+)+-[0-9]", region):
        raise ValueError("Configure AWS_REGION.")
    return boto3.Session(region_name=region).client(
        service, config=Config(connect_timeout=10, read_timeout=30,
                               retries={"mode": "standard", "total_max_attempts": 3}))


def docker_run(arguments, *, input_text=None, timeout=1200):
    # Never stream registry tokens or potentially sensitive Docker diagnostics.
    subprocess.run(["docker", *arguments], input=input_text, text=True,
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=timeout)


def publish_image(ecr, repository, revision, context, run=docker_run):
    repository_value(repository)
    revision_value(revision)
    context = Path(context).resolve()
    if not (context / "Dockerfile").is_file() or not (context / ".dockerignore").is_file():
        raise ValueError("Prepare the approved code-only container context first.")
    records = ecr.describe_repositories(repositoryNames=[repository])["repositories"]
    if len(records) != 1 or records[0].get("imageTagMutability") != "IMMUTABLE":
        raise ValueError("The deployment ECR repository must enforce immutable tags without exclusions.")
    uri = records[0]["repositoryUri"]
    image_value(uri + "@sha256:" + "0" * 64)
    try:
        details = ecr.describe_images(repositoryName=repository, imageIds=[{"imageTag": revision}])["imageDetails"]
    except ecr.exceptions.ImageNotFoundException:
        details = []
    reused = bool(details)
    if not reused:
        registry = uri.split("/", 1)[0]
        credentials = ecr.get_authorization_token(registryIds=[registry.split(".", 1)[0]])["authorizationData"]
        credentials = [entry for entry in credentials if entry["proxyEndpoint"] == "https://" + registry]
        if len(credentials) != 1:
            raise RuntimeError("Registry authentication did not match the approved repository.")
        username, password = base64.b64decode(credentials[0]["authorizationToken"], validate=True).decode().split(":", 1)
        if username != "AWS" or not password:
            raise RuntimeError("Unexpected registry authentication format.")
        with tempfile.TemporaryDirectory(prefix="drivemate-docker-") as config:
            run(["--config", config, "login", "--username", username, "--password-stdin", registry],
                input_text=password, timeout=60)
            tag = uri + ":" + revision
            run(["--config", config, "build", "--platform", "linux/amd64", "--label",
                 "org.opencontainers.image.revision=" + revision, "--tag", tag, str(context)])
            run(["--config", config, "push", tag])
        details = ecr.describe_images(repositoryName=repository, imageIds=[{"imageTag": revision}])["imageDetails"]
    if len(details) != 1:
        raise RuntimeError("Expected exactly one immutable image for this source revision.")
    return {"source_revision": revision, "image": image_value(uri + "@" + details[0]["imageDigest"]),
            "reused_immutable_image": reused}


def service_state(ecs, cluster, service):
    result = ecs.describe_services(cluster=cluster, services=[service])
    if result.get("failures") or len(result.get("services", [])) != 1:
        raise RuntimeError("The configured ECS service could not be read.")
    return result["services"][0]


def stable_revision(service, expected):
    deployments = service.get("deployments", [])
    return (service.get("status") == "ACTIVE" and service.get("desiredCount") == 1
            and service.get("runningCount") == 1 and service.get("pendingCount") == 0
            and service.get("taskDefinition") == expected and len(deployments) == 1
            and deployments[0].get("taskDefinition") == expected
            and deployments[0].get("rolloutState") == "COMPLETED")


def clone_task(task, image, family):
    image_value(image)
    if task.get("family") != family or task.get("status") != "ACTIVE":
        raise ValueError("The active service task does not match the approved API family.")
    if task.get("networkMode") != "awsvpc" or "FARGATE" not in task.get("requiresCompatibilities", []):
        raise ValueError("The API must use Fargate with awsvpc networking.")
    containers = task.get("containerDefinitions", [])
    if len(containers) != 2 or {item.get("name") for item in containers} != {"api", "nginx"}:
        raise ValueError("Only the existing api/nginx task may be deployed.")
    result = {name: copy.deepcopy(task[name]) for name in REGISTER_FIELDS if name in task}
    for container in result["containerDefinitions"]:
        if not container.get("essential", True) or not container.get("healthCheck"):
            raise ValueError("Both API containers need essential health checks before deployment.")
        container["image"] = image
    return result


def wait_stable(ecs, cluster, service, expected):
    ecs.get_waiter("services_stable").wait(cluster=cluster, services=[service], WaiterConfig=WAITER_CONFIG)
    # A circuit-breaker rollback can make the waiter succeed on the OLD revision.
    if not stable_revision(service_state(ecs, cluster, service), expected):
        raise RuntimeError("The expected ECS task revision did not become healthy.")


def deploy_service(ecs, cluster, service, family, image, revision, report_path):
    for value, label in ((cluster, "ECS cluster"), (service, "ECS service"), (family, "API task family")):
        name_value(value, label)
    image_value(image)
    revision_value(revision)
    previous = service_state(ecs, cluster, service)
    old_arn = previous.get("taskDefinition")
    config = previous.get("deploymentConfiguration", {})
    if (not stable_revision(previous, old_arn)
            or previous.get("deploymentController", {}).get("type", "ECS") != "ECS"
            or config.get("minimumHealthyPercent") != 0 or config.get("maximumPercent") != 100
            or config.get("deploymentCircuitBreaker") != {"enable": True, "rollback": True}):
        raise ValueError("Require a stable single-task service, 0/100 rollout and circuit-breaker rollback.")
    task = ecs.describe_task_definition(taskDefinition=old_arn)["taskDefinition"]
    registration = clone_task(task, image, family)
    if all(item.get("image") == image for item in task["containerDefinitions"]):
        result = {"status": "already_deployed", "source_revision": revision, "image": image,
                  "previous_task_definition": old_arn, "task_definition": old_arn}
        Path(report_path).write_text(json.dumps(result, indent=2), encoding="utf-8")
        return result
    new_arn = ecs.register_task_definition(**registration)["taskDefinition"]["taskDefinitionArn"]
    report = {"status": "registered", "source_revision": revision, "image": image,
              "previous_task_definition": old_arn, "task_definition": new_arn}

    def save(status):
        report["status"] = status
        Path(report_path).write_text(json.dumps(report, indent=2), encoding="utf-8")

    save("registered")
    # Do not supersede an operator deployment made while we registered our revision.
    if not stable_revision(service_state(ecs, cluster, service), old_arn):
        save("concurrent_change")
        raise RuntimeError("The service changed during preparation; no service update was requested.")
    try:
        ecs.update_service(cluster=cluster, service=service, taskDefinition=new_arn)
        save("updating")
        wait_stable(ecs, cluster, service, new_arn)
    except Exception:
        current = service_state(ecs, cluster, service)
        if current.get("taskDefinition") not in {old_arn, new_arn}:
            save("concurrent_change")
            raise RuntimeError("Another task revision is active; automatic rollback was not attempted.") from None
        try:
            if current.get("taskDefinition") != old_arn:
                ecs.update_service(cluster=cluster, service=service, taskDefinition=old_arn)
            wait_stable(ecs, cluster, service, old_arn)
        except Exception:
            save("rollback_unverified")
            raise RuntimeError("Deployment failed and recovery is unverified; inspect ECS before retrying.") from None
        save("rolled_back")
        raise RuntimeError("Deployment failed; the previous task revision is healthy again.") from None
    save("healthy")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    stage = actions.add_parser("stage")
    stage.add_argument("--repo", default=".")
    stage.add_argument("--archive", required=True)
    stage.add_argument("--sha256", required=True)
    stage.add_argument("--revision", required=True)
    publish = actions.add_parser("image")
    publish.add_argument("--context", required=True)
    publish.add_argument("--revision", required=True)
    publish.add_argument("--output", required=True)
    deploy = actions.add_parser("deploy")
    deploy.add_argument("--image-file", required=True)
    deploy.add_argument("--revision", required=True)
    deploy.add_argument("--report", required=True)
    args = parser.parse_args()
    try:
        if args.action == "stage":
            result = stage_artifacts(args.repo, args.archive, args.revision, args.sha256)
        elif args.action == "image":
            result = publish_image(aws_client("ecr", os.environ.get("AWS_REGION", "")),
                                   os.environ.get("ECR_REPOSITORY", ""), args.revision, args.context)
            Path(args.output).write_text(json.dumps(result, indent=2), encoding="utf-8")
        else:
            image = json.loads(Path(args.image_file).read_text(encoding="utf-8"))
            if image.get("source_revision") != args.revision:
                raise ValueError("Image source identity mismatch.")
            result = deploy_service(aws_client("ecs", os.environ.get("AWS_REGION", "")),
                                    os.environ.get("ECS_CLUSTER", ""), os.environ.get("ECS_SERVICE", ""),
                                    os.environ.get("ECS_API_TASK_FAMILY", ""), image["image"], args.revision, args.report)
        print(json.dumps(result))
        return 0
    except (ValueError, RuntimeError) as error:
        # Only our bounded, static validation errors are printable.
        print(json.dumps({"status": "failed", "reason": str(error)}), file=sys.stderr)
    except Exception as error:
        print(json.dumps({"status": "failed", "error_type": type(error).__name__,
                          "reason": "Deployment operation failed; no credentials or runtime configuration were logged."}), file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
