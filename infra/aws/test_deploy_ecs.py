"""Synthetic clients only: no AWS calls, registry credentials or running containers."""
import base64
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

import deploy_ecs as deploy
import test_deploy_release
import deploy_release

IMAGE = "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/drivemate@sha256:" + "a" * 64
OLD = "arn:aws:ecs:ap-northeast-2:123456789012:task-definition/drivemate-api:1"
NEW = OLD[:-1] + "2"
SAMPLE_SECRET = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:drivemate-hyundai-AbCdEf"


def task_definition():
    return {"family": "drivemate-api", "taskDefinitionArn": OLD, "status": "ACTIVE", "revision": 1,
            "networkMode": "awsvpc", "requiresCompatibilities": ["FARGATE"], "cpu": "1024", "memory": "4096",
            "executionRoleArn": "arn:aws:iam::123456789012:role/execution",
            "taskRoleArn": "arn:aws:iam::123456789012:role/api",
            "containerDefinitions": [{"name": name, "image": IMAGE.replace("a" * 64, "b" * 64),
                                      "essential": True, "healthCheck": {"command": ["CMD-SHELL", "health-check"]},
                                      "secrets": [{"name": "SECRET_REFERENCE", "valueFrom": "synthetic-secret-arn"}],
                                      "environment": [{"name": "PRIVATE_RELEASE_SHA256", "value": "c" * 64}]}
                                     for name in ["api", "nginx"]], "registeredBy": "synthetic-metadata"}


def service(arn=OLD):
    return {"status": "ACTIVE", "desiredCount": 1, "runningCount": 1, "pendingCount": 0,
            "taskDefinition": arn, "deploymentController": {"type": "ECS"},
            "deploymentConfiguration": {"minimumHealthyPercent": 0, "maximumPercent": 100,
                                        "deploymentCircuitBreaker": {"enable": True, "rollback": True}},
            "deployments": [{"taskDefinition": arn, "rolloutState": "COMPLETED"}]}


class EcsDeployTests(unittest.TestCase):
    def test_sample_configuration_requires_explicit_complete_settings(self):
        self.assertIsNone(deploy.hyundai_sample_configuration("", ""))
        self.assertEqual(deploy.hyundai_sample_configuration("false", ""), {"enabled": False})
        for enabled, arn in [("true", ""), ("", SAMPLE_SECRET), ("false", SAMPLE_SECRET),
                             ("yes", SAMPLE_SECRET), ("true", "synthetic-token"),
                             ("true", SAMPLE_SECRET + ":key::"), ("true", SAMPLE_SECRET + "\n")]:
            with self.subTest(enabled=enabled, arn=arn), self.assertRaises(ValueError):
                deploy.hyundai_sample_configuration(enabled, arn)

    def test_sample_secrets_are_only_references_in_api_and_preserve_other_settings(self):
        original = task_definition()
        original["containerDefinitions"][0]["environment"].extend([
            {"name": "DRIVEMATE_PROVIDER_MODE", "value": "live"},
            {"name": "HYUNDAI_SAMPLE_TOKEN", "value": "synthetic-stale-plaintext"}])
        config = deploy.hyundai_sample_configuration("true", SAMPLE_SECRET)
        cloned = deploy.clone_task(original, IMAGE, "drivemate-api", config)
        api, nginx = cloned["containerDefinitions"]
        self.assertNotIn("synthetic-stale-plaintext", json.dumps(cloned))
        self.assertIn({"name": "DRIVEMATE_PROVIDER_MODE", "value": "live"}, api["environment"])
        self.assertIn({"name": "DRIVEMATE_HYUNDAI_SAMPLE_ENABLED", "value": "true"}, api["environment"])
        for name in ("HYUNDAI_SAMPLE_TOKEN", "HYUNDAI_SAMPLE_CAR_ID"):
            self.assertIn({"name": name, "valueFrom": SAMPLE_SECRET + ":" + name + "::"}, api["secrets"])
        expected_nginx = copy.deepcopy(original["containerDefinitions"][1])
        expected_nginx["image"] = IMAGE
        self.assertEqual(nginx, expected_nginx)
        self.assertEqual(deploy.clone_task({**cloned, "status": "ACTIVE"}, IMAGE, "drivemate-api", config), cloned)
        disabled = deploy.clone_task({**cloned, "status": "ACTIVE"}, IMAGE, "drivemate-api", {"enabled": False})
        self.assertFalse(any(item["name"].startswith("HYUNDAI_SAMPLE_") for item in disabled["containerDefinitions"][0]["secrets"]))

    def test_same_image_still_rolls_out_changed_sample_configuration(self):
        client = self.client()
        for item in client.describe_task_definition.return_value["taskDefinition"]["containerDefinitions"]:
            item["image"] = IMAGE
        client.describe_services.side_effect = [{"services": [service(arn)]} for arn in [OLD, OLD, NEW]]
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "report.json"
            result = deploy.deploy_service(client, "drivemate", "api", "drivemate-api", IMAGE, "d" * 40, report,
                                           deploy.hyundai_sample_configuration("true", SAMPLE_SECRET))
            self.assertEqual(result["status"], "healthy")
            self.assertNotIn(SAMPLE_SECRET, report.read_text())
        client.register_task_definition.assert_called_once()
        client.update_service.assert_called_once()

    def test_identical_image_and_sample_configuration_skip_rollout(self):
        client = self.client()
        config = deploy.hyundai_sample_configuration("true", SAMPLE_SECRET)
        task = deploy.clone_task(task_definition(), IMAGE, "drivemate-api", config)
        client.describe_task_definition.return_value = {"taskDefinition": {**task, "status": "ACTIVE"}}
        with tempfile.TemporaryDirectory() as directory:
            result = deploy.deploy_service(client, "drivemate", "api", "drivemate-api", IMAGE, "d" * 40,
                                           Path(directory) / "report.json", config)
            self.assertEqual(result["status"], "already_deployed")
        client.register_task_definition.assert_not_called()
        client.update_service.assert_not_called()

    def client(self):
        client = Mock()
        client.describe_services.return_value = {"services": [service()]}
        client.describe_task_definition.return_value = {"taskDefinition": task_definition()}
        client.register_task_definition.return_value = {"taskDefinition": {"taskDefinitionArn": NEW}}
        return client

    def deploy(self, client, report):
        return deploy.deploy_service(client, "drivemate", "api", "drivemate-api", IMAGE, "d" * 40, report)

    def test_clone_changes_only_two_images_and_preserves_runtime_references(self):
        original = task_definition()
        cloned = deploy.clone_task(original, IMAGE, "drivemate-api")
        expected = {key: copy.deepcopy(original[key]) for key in deploy.REGISTER_FIELDS if key in original}
        for item in expected["containerDefinitions"]:
            item["image"] = IMAGE
        self.assertEqual(cloned, expected)
        self.assertNotEqual(original["containerDefinitions"][0]["image"], IMAGE)
        self.assertNotIn("registeredBy", cloned)
        for change in (lambda value: value.update(networkMode="bridge"),
                       lambda value: value["containerDefinitions"].append({"name": "cycle"}),
                       lambda value: value["containerDefinitions"][0].pop("healthCheck")):
            modified = task_definition()
            change(modified)
            with self.assertRaises(ValueError):
                deploy.clone_task(modified, IMAGE, "drivemate-api")

    def test_unstable_service_stops_before_registering_or_updating(self):
        client = self.client()
        client.describe_services.return_value["services"][0]["pendingCount"] = 1
        with self.assertRaises(ValueError):
            self.deploy(client, "unused.json")
        client.register_task_definition.assert_not_called()
        client.update_service.assert_not_called()

    def test_success_requires_expected_healthy_revision(self):
        client = self.client()
        client.describe_services.side_effect = [{"services": [service(arn)]} for arn in [OLD, OLD, NEW]]
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "report.json"
            self.assertEqual(self.deploy(client, report)["status"], "healthy")
            self.assertEqual(json.loads(report.read_text())["task_definition"], NEW)
            self.assertNotIn("SECRET_REFERENCE", report.read_text())
        client.update_service.assert_called_once_with(cluster="drivemate", service="api", taskDefinition=NEW)

    def test_circuit_breaker_returning_old_revision_is_not_success(self):
        client = self.client()
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "report.json"
            with self.assertRaisesRegex(RuntimeError, "previous task revision is healthy"):
                self.deploy(client, report)
            self.assertEqual(json.loads(report.read_text())["status"], "rolled_back")
        self.assertEqual(client.update_service.call_count, 1)

    def test_failed_new_task_restores_previous_and_checks_it(self):
        client = self.client()
        client.describe_services.side_effect = [{"services": [service(arn)]} for arn in [OLD, OLD, NEW, OLD]]
        client.get_waiter.return_value.wait.side_effect = [RuntimeError("synthetic timeout"), None]
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "report.json"
            with self.assertRaisesRegex(RuntimeError, "previous task revision is healthy"):
                self.deploy(client, report)
            self.assertEqual(json.loads(report.read_text())["status"], "rolled_back")
        self.assertEqual([call.kwargs["taskDefinition"] for call in client.update_service.call_args_list], [NEW, OLD])

    def test_concurrent_operator_change_is_not_overwritten(self):
        client = self.client()
        client.describe_services.side_effect = [{"services": [service(arn)]} for arn in [OLD, OLD, OLD[:-1] + "9"]]
        client.get_waiter.return_value.wait.side_effect = RuntimeError("synthetic timeout")
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "report.json"
            with self.assertRaisesRegex(RuntimeError, "Another task revision"):
                self.deploy(client, report)
            self.assertEqual(json.loads(report.read_text())["status"], "concurrent_change")
        self.assertEqual(client.update_service.call_count, 1)

    def test_staging_reuses_release_checks_and_only_extracts_tested_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source = test_deploy_release.ReleaseTests().create_repo(base / "source")
            result = deploy_release.package(source, base / "release", "d" * 40)
            repo = base / "checkout"
            repo.mkdir()
            deploy.stage_artifacts(repo, base / "release/code-release.zip", "d" * 40, result["archive_sha256"])
            self.assertTrue((repo / "dist/index.html").is_file())
            self.assertTrue((repo / deploy.JAR).is_file())
            self.assertFalse((repo / "backend/scripts").exists())
            self.assertFalse((repo / ".env.llm.local").exists())
            with self.assertRaises(ValueError):
                deploy.stage_artifacts(repo, base / "release/code-release.zip", "d" * 40, result["archive_sha256"])

    def test_existing_immutable_image_does_not_request_registry_token_or_build(self):
        client = Mock()
        client.describe_repositories.return_value = {"repositories": [{"repositoryUri": IMAGE.split("@")[0], "imageTagMutability": "IMMUTABLE"}]}
        client.describe_images.return_value = {"imageDetails": [{"imageDigest": "sha256:" + "a" * 64}]}
        runner = Mock()
        with tempfile.TemporaryDirectory() as directory:
            for name in ["Dockerfile", ".dockerignore"]:
                (Path(directory) / name).touch()
            result = deploy.publish_image(client, "drivemate", "d" * 40, directory, runner)
            self.assertEqual(result["image"], IMAGE)
            self.assertTrue(result["reused_immutable_image"])
            client.get_authorization_token.assert_not_called()
            runner.assert_not_called()

    def test_new_image_sends_registry_password_only_to_stdin_and_pins_digest(self):
        class MissingImage(Exception):
            pass
        client = Mock()
        client.exceptions.ImageNotFoundException = MissingImage
        uri = IMAGE.split("@")[0]
        client.describe_repositories.return_value = {"repositories": [{"repositoryUri": uri, "imageTagMutability": "IMMUTABLE"}]}
        client.describe_images.side_effect = [MissingImage(), {"imageDetails": [{"imageDigest": "sha256:" + "a" * 64}]}]
        client.get_authorization_token.return_value = {"authorizationData": [{
            "proxyEndpoint": "https://" + uri.split("/")[0],
            "authorizationToken": base64.b64encode(b"AWS:synthetic-password").decode()}]}
        runner = Mock()
        with tempfile.TemporaryDirectory() as directory:
            for name in ["Dockerfile", ".dockerignore"]:
                (Path(directory) / name).touch()
            result = deploy.publish_image(client, "drivemate", "d" * 40, directory, runner)
        self.assertEqual(result["image"], IMAGE)
        calls = runner.call_args_list
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[0].kwargs["input_text"], "synthetic-password")
        self.assertIn("--password-stdin", calls[0].args[0])
        self.assertTrue(all("synthetic-password" not in str(call.args) for call in calls))
        self.assertIn("linux/amd64", calls[1].args[0])
        self.assertFalse(Path(calls[0].args[0][1]).exists())

    def test_changed_service_during_preparation_does_not_update(self):
        client = self.client()
        client.describe_services.side_effect = [{"services": [service(arn)]} for arn in [OLD, OLD[:-1] + "9"]]
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "changed during preparation"):
                self.deploy(client, Path(directory) / "report.json")
        client.update_service.assert_not_called()

    def test_oidc_policy_is_fixed_and_cannot_run_cycle_or_read_private_data(self):
        template = json.loads((Path(__file__).parent / "cicd-ecs.json").read_text())
        role = template["Resources"]["DeployRole"]["Properties"]
        trusted = role["AssumeRolePolicyDocument"]["Statement"][0]["Condition"]["StringEquals"]
        self.assertEqual(trusted["token.actions.githubusercontent.com:aud"], "sts.amazonaws.com")
        self.assertEqual(trusted["token.actions.githubusercontent.com:sub"],
                         "repo:cloud-project-mobility@341333303/make_drive_mate@1445282042:ref:refs/heads/main")
        statements = role["Policies"][0]["PolicyDocument"]["Statement"]
        actions = {action for statement in statements for action in
                   ([statement["Action"]] if isinstance(statement["Action"], str) else statement["Action"])}
        self.assertFalse(any(action.startswith(("s3:", "secretsmanager:", "ssm:", "rds:")) for action in actions))
        self.assertNotIn("ecs:RunTask", actions)
        delegation = next(item for item in statements if item["Sid"] == "PassOnlyApiRoles")
        self.assertEqual(delegation["Resource"], [{"Ref": "ExecutionRoleArn"}, {"Ref": "ApiTaskRoleArn"}])
        self.assertEqual(delegation["Condition"]["StringEquals"]["iam:PassedToService"], "ecs-tasks.amazonaws.com")


if __name__ == "__main__":
    unittest.main()

