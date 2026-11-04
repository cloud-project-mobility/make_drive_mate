"""Deployment invariants for the single-process location relay and scoped roles."""
import importlib.util
import json
import re
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("ecs_templates", HERE / "build_ecs_templates.py")
TEMPLATES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TEMPLATES)


class EcsTemplatesTests(unittest.TestCase):
    def setUp(self):
        self.foundation = TEMPLATES.foundation()
        self.service = TEMPLATES.service()
        self.resources = self.service["Resources"]

    def test_generated_files_match_builder(self):
        for name, expected in [("foundation", self.foundation), ("service", self.service)]:
            self.assertEqual(json.loads((HERE / f"ecs-{name}.json").read_text()), expected)

    def test_only_untagged_images_expire_and_repository_is_retained(self):
        repository = self.foundation["Resources"]["Repository"]
        self.assertEqual(repository["DeletionPolicy"], "Retain")
        self.assertEqual(repository["UpdateReplacePolicy"], "Retain")
        self.assertEqual(repository["Properties"]["ImageTagMutability"], "IMMUTABLE")
        rules = json.loads(repository["Properties"]["LifecyclePolicy"]["LifecyclePolicyText"])["rules"]
        self.assertTrue(all(rule["selection"]["tagStatus"] == "untagged" for rule in rules))

    def test_deployment_never_runs_two_location_relays(self):
        service = self.resources["Service"]["Properties"]
        self.assertEqual(service["DesiredCount"], 1)
        self.assertEqual(service["DeploymentConfiguration"], {
            "MinimumHealthyPercent": 0, "MaximumPercent": 100,
            "DeploymentCircuitBreaker": {"Enable": True, "Rollback": True}})
        self.assertEqual(service["AvailabilityZoneRebalancing"], "DISABLED")
        self.assertEqual(len(service["NetworkConfiguration"]["AwsvpcConfiguration"]["Subnets"]), 2)

    def test_no_database_replacement_or_public_ingress(self):
        self.assertFalse(any(item["Type"].startswith("AWS::RDS::") for item in self.resources.values()))
        for resource in self.resources.values():
            properties = resource["Properties"]
            rules = properties.get("SecurityGroupIngress", [])
            if resource["Type"] == "AWS::EC2::SecurityGroupIngress":
                rules = [properties]
            for rule in rules:
                self.assertNotIn("CidrIp", rule)
                self.assertNotIn("CidrIpv6", rule)
        self.assertEqual(self.resources["LoadBalancer"]["Properties"]["Scheme"], "internal")

    def test_api_has_no_job_write_or_secret_fetch_permissions(self):
        statements = self.resources["ApiTaskRole"]["Properties"]["Policies"][0]["PolicyDocument"]["Statement"]
        self.assertEqual({action for item in statements for action in item["Action"]}, {"s3:GetObject", "s3:ListBucket"})
        self.assertNotIn("*", json.dumps(statements))
        listing = [item for item in statements if "s3:ListBucket" in item["Action"]]
        self.assertEqual(len(listing), 1)
        self.assertEqual(listing[0]["Condition"], {"StringEquals": {"s3:prefix": "data/cycles/latest.json"}})
        api = self.resources["ApiTask"]["Properties"]["ContainerDefinitions"][0]
        required_secrets = [item for item in api["Secrets"] if "Name" in item]
        self.assertEqual({item["Name"] for item in required_secrets}, {
            "DRIVEMATE_DB_PASSWORD", "OPENAI_API_KEY", "OPENAI_MODEL", "DRIVEMATE_KNOWLEDGE_ALLOWED_EMAILS"})
        self.assertTrue(all(item["ValueFrom"]["Fn::Sub"].endswith("::") for item in required_secrets))

    def test_optional_kakao_secret_is_scoped_and_never_injected_when_absent(self):
        parameter = self.service["Parameters"]["KakaoSecretArn"]
        self.assertEqual(parameter["Default"], "")
        pattern = parameter["AllowedPattern"]
        valid_arn = "arn:aws:secretsmanager:ap-southeast-2:111122223333:secret:example/kakao-AbCd12"
        for value in ("", valid_arn):
            self.assertIsNotNone(re.fullmatch(pattern, value))
        for value in ("*", valid_arn + ":DRIVEMATE_KAKAO_REST_KEY::", valid_arn + "*"):
            self.assertIsNone(re.fullmatch(pattern, value))
        self.assertEqual(self.service["Conditions"]["HasKakao"], {
            "Fn::Not": [{"Fn::Equals": [{"Ref": "KakaoSecretArn"}, ""]}]})
        api = self.resources["ApiTask"]["Properties"]["ContainerDefinitions"][0]
        mode = next(item["Value"] for item in api["Environment"] if item["Name"] == "DRIVEMATE_PROVIDER_MODE")
        self.assertEqual(mode, {"Fn::If": ["HasKakao", "live", "mock"]})
        optional = [item for item in api["Secrets"] if "Fn::If" in item]
        self.assertEqual(optional, [{"Fn::If": ["HasKakao", {
            "Name": "DRIVEMATE_KAKAO_REST_KEY",
            "ValueFrom": {"Fn::Sub": "${KakaoSecretArn}:DRIVEMATE_KAKAO_REST_KEY::"}}, {"Ref": "AWS::NoValue"}]}])
        statements = self.resources["ExecutionRole"]["Properties"]["Policies"][0]["PolicyDocument"]["Statement"]
        secret_permissions = [item for item in statements if "secretsmanager:GetSecretValue" in item["Action"]]
        self.assertEqual(secret_permissions, [{"Effect": "Allow", "Action": ["secretsmanager:GetSecretValue"],
            "Resource": [{"Ref": "AppSecretArn"}, {"Fn::If": ["HasKakao", {"Ref": "KakaoSecretArn"}, {"Ref": "AWS::NoValue"}]}]}])

    def test_proxy_has_no_secrets_and_waits_for_api_health(self):
        api, nginx = self.resources["ApiTask"]["Properties"]["ContainerDefinitions"]
        self.assertEqual(api["Image"], nginx["Image"])
        self.assertEqual(nginx["Secrets"], [])
        self.assertEqual(nginx["DependsOn"], [{"ContainerName": "api", "Condition": "HEALTHY"}])
        self.assertIn("HealthCheck", api)
        for container in (api, nginx):
            self.assertEqual(container["User"], "10001:10001")
            self.assertTrue(container["ReadonlyRootFilesystem"])
            self.assertEqual(container["LinuxParameters"]["Capabilities"]["Drop"], ["ALL"])

    def test_cycle_is_separate_one_shot_with_onbid_only(self):
        cycle = self.resources["CycleTask"]["Properties"]
        self.assertEqual(cycle["TaskRoleArn"], {"Fn::GetAtt": ["CycleTaskRole", "Arn"]})
        self.assertEqual(cycle["ContainerDefinitions"][0]["Command"], ["cycle"])
        self.assertEqual([item["Name"] for item in cycle["ContainerDefinitions"][0]["Secrets"]], ["ONBID_SERVICE_KEY"])
        self.assertEqual(sum(item["Type"] == "AWS::ECS::Service" for item in self.resources.values()), 1)

    def test_cloudfront_does_not_cache_authenticated_requests(self):
        config = self.resources["Distribution"]["Properties"]["DistributionConfig"]
        self.assertEqual(config["DefaultCacheBehavior"]["ViewerProtocolPolicy"], "redirect-to-https")
        self.assertEqual(config["DefaultCacheBehavior"]["CachePolicyId"], "4135ea2d-6df8-44a3-9df3-4b5a84be39ad")
        self.assertEqual(config["Origins"][0]["VpcOriginConfig"]["OriginReadTimeout"], 120)

    def test_pointer_allows_verified_metadata_path_only(self):
        pattern = self.service["Parameters"]["RagPointerKey"]["AllowedPattern"]
        self.assertIsNotNone(re.fullmatch(pattern, "data/rag/pointers/" + "a" * 64 + ".json"))
        self.assertIsNotNone(re.fullmatch(pattern, "releases/20261104/pointer.json"))
        self.assertIsNone(re.fullmatch(pattern, "data/rag/collections/private.json"))
        self.assertIsNone(re.fullmatch(pattern, "data/rag/pointers/unverified.json"))


if __name__ == "__main__":
    unittest.main()
