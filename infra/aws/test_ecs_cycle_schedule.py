import json
from pathlib import Path
import unittest


class CycleScheduleTests(unittest.TestCase):
    def setUp(self):
        self.template = json.loads((Path(__file__).parent / "ecs-cycle-schedule.json").read_text())
        self.resources = self.template["Resources"]

    def test_schedule_is_disabled_and_does_not_create_a_queue_or_service(self):
        self.assertEqual(self.template["Parameters"]["EnableSchedule"]["Default"], "DISABLED")
        self.assertEqual(self.resources["HourlyPoll"]["Properties"]["ScheduleExpression"], "cron(5 * * * ? *)")
        self.assertFalse(any(item["Type"] in {"AWS::SQS::Queue", "AWS::ECS::Service"} for item in self.resources.values()))

    def test_role_trust_and_permissions_are_exact(self):
        role = self.resources["ScheduleRole"]["Properties"]
        trust = role["AssumeRolePolicyDocument"]["Statement"][0]
        self.assertEqual(trust["Principal"], {"Service": "events.amazonaws.com"})
        self.assertEqual(trust["Condition"]["StringEquals"], {"aws:SourceAccount": {"Ref": "AWS::AccountId"}})
        self.assertTrue(trust["Condition"]["ArnEquals"]["aws:SourceArn"]["Fn::Sub"].endswith("rule/${RuleName}"))
        run, passed = role["Policies"][0]["PolicyDocument"]["Statement"]
        self.assertEqual(run["Action"], "ecs:RunTask")
        self.assertEqual(run["Resource"], {"Ref": "CycleTaskDefinitionArn"})
        self.assertEqual(run["Condition"], {"ArnEquals": {"ecs:cluster": {"Ref": "ClusterArn"}}})
        self.assertEqual(passed["Resource"], [{"Ref": "ExecutionRoleArn"}, {"Ref": "CycleTaskRoleArn"}])
        self.assertEqual(passed["Condition"], {"StringEquals": {"iam:PassedToService": "ecs-tasks.amazonaws.com"}})

    def test_target_uses_exact_revision_and_existing_outbound_network(self):
        target = self.resources["HourlyPoll"]["Properties"]["Targets"][0]
        params = target["EcsParameters"]
        self.assertEqual(params["TaskDefinitionArn"], {"Ref": "CycleTaskDefinitionArn"})
        self.assertEqual(params["TaskCount"], 1)
        self.assertEqual(params["LaunchType"], "FARGATE")
        self.assertEqual(params["NetworkConfiguration"]["AwsVpcConfiguration"], {
            "AssignPublicIp": "ENABLED", "SecurityGroups": [{"Ref": "TaskSecurityGroupId"}],
            "Subnets": {"Ref": "TaskSubnetIds"}})
        self.assertNotIn("Input", target)
        self.assertEqual(target["RetryPolicy"], {"MaximumEventAgeInSeconds": 3600, "MaximumRetryAttempts": 2})

    def test_alarm_is_delivery_only_without_notifications(self):
        alarm = self.resources["InvocationFailures"]["Properties"]
        self.assertEqual(alarm["MetricName"], "FailedInvocations")
        self.assertFalse(alarm["ActionsEnabled"])
        self.assertEqual(alarm["TreatMissingData"], "notBreaching")
        self.assertNotIn("AlarmActions", alarm)


if __name__ == "__main__":
    unittest.main()
