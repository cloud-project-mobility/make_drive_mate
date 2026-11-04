"""Generate separate ECS templates without changing the retained database stack."""
import argparse
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


def ref(name):
    return {"Ref": name}


def sub(value):
    return {"Fn::Sub": value}


def attr(name, key):
    return {"Fn::GetAtt": [name, key]}


def resource(kind, properties, why, must=(), **extra):
    return {"Type": "AWS::" + kind,
            "Metadata": {"com.aws.cloudformation.Context": {"why": why, "must": list(must)}},
            "Properties": properties, **extra}


def template(description):
    return {"AWSTemplateFormatVersion": "2010-09-09", "Description": description,
            "Metadata": {"AWSToolsMetrics": {"AWSAgentToolkit": "aws-cloudformation@3"}},
            "Resources": {}}


def output(value, description):
    return {"Value": value, "Description": description}


def foundation():
    data = template("DriveMate immutable container images and Fargate cluster; no application compute or database replacement.")
    resources = data["Resources"]
    resources["Repository"] = resource("ECR::Repository", {
        "ImageTagMutability": "IMMUTABLE",
        "ImageScanningConfiguration": {"ScanOnPush": True},
        "EncryptionConfiguration": {"EncryptionType": "AES256"},
        "LifecyclePolicy": {"LifecyclePolicyText": json.dumps({"rules": [{
            "rulePriority": 1, "description": "Remove only untagged images after 14 days",
            "selection": {"tagStatus": "untagged", "countType": "sinceImagePushed", "countUnit": "days", "countNumber": 14},
            "action": {"type": "expire"}}]}, separators=(",", ":"))},
        "Tags": [{"Key": "Project", "Value": "DriveMate"}]},
        "Retain immutable tagged releases for deployment rollback", ["no public repository policy", "tagged images never expire automatically"],
        DeletionPolicy="Retain", UpdateReplacePolicy="Retain")
    resources["Cluster"] = resource("ECS::Cluster", {
        "CapacityProviders": ["FARGATE"],
        "DefaultCapacityProviderStrategy": [{"CapacityProvider": "FARGATE", "Weight": 1}],
        "ClusterSettings": [{"Name": "containerInsights", "Value": "disabled"}],
        "Tags": [{"Key": "Project", "Value": "DriveMate"}]},
        "Run containers without a persistent EC2 application host", ["on-demand Fargate", "no tasks until service deployment"])
    resources["Logs"] = resource("Logs::LogGroup", {"RetentionInDays": 14},
        "Retain bounded API, proxy and cycle operational logs", ["no credentials, payloads or location coordinates"],
        DeletionPolicy="Retain", UpdateReplacePolicy="Retain")
    data["Outputs"] = {
        "RepositoryName": output(ref("Repository"), "Immutable ECR repository name"),
        "RepositoryUri": output(attr("Repository", "RepositoryUri"), "ECR image prefix; deploy by digest"),
        "RepositoryArn": output(attr("Repository", "Arn"), "Scoped ECR pull and push policy resource"),
        "ClusterName": output(ref("Cluster"), "ECS cluster name"),
        "ClusterArn": output(attr("Cluster", "Arn"), "ECS cluster ARN"),
        "LogGroupName": output(ref("Logs"), "Fourteen-day operational log group"),
        "LogGroupArn": output(attr("Logs", "Arn"), "Operational log group ARN")}
    return data


def statement(actions, resources):
    return {"Effect": "Allow", "Action": actions, "Resource": resources}


def role(statements, purpose):
    return resource("IAM::Role", {
        "AssumeRolePolicyDocument": {"Version": "2012-10-17", "Statement": [{
            "Effect": "Allow", "Principal": {"Service": "ecs-tasks.amazonaws.com"},
            "Action": "sts:AssumeRole", "Condition": {
                "StringEquals": {"aws:SourceAccount": ref("AWS::AccountId")},
                "ArnLike": {"aws:SourceArn": sub("arn:${AWS::Partition}:ecs:${AWS::Region}:${AWS::AccountId}:*")}}}]},
        "Policies": [{"PolicyName": "Runtime", "PolicyDocument": {"Version": "2012-10-17", "Statement": statements}}]},
        purpose, ["no stored AWS credentials", "resource-scoped application permissions"])


def secret(name):
    return {"Name": name, "ValueFrom": sub("${AppSecretArn}:" + name + "::")}


def environment(values):
    return [{"Name": name, "Value": value} for name, value in values.items()]


def container(name, env, secrets=()):
    return {
        "Name": name, "Image": ref("ImageUri"), "Command": [name], "Essential": True,
        "User": "10001:10001", "ReadonlyRootFilesystem": True,
        "LinuxParameters": {"InitProcessEnabled": True, "Capabilities": {"Drop": ["ALL"]}},
        "Environment": environment(env), "Secrets": list(secrets), "StopTimeout": 60,
        "LogConfiguration": {"LogDriver": "awslogs", "Options": {
            "awslogs-group": ref("LogGroupName"), "awslogs-region": ref("AWS::Region"),
            "awslogs-stream-prefix": name, "mode": "non-blocking", "max-buffer-size": "4m"}}}


def task_definition(family, execution_role, task_role, containers, volumes, memory="3072"):
    return resource("ECS::TaskDefinition", {
        "Family": sub("${AWS::StackName}-" + family), "Cpu": "1024", "Memory": memory,
        "NetworkMode": "awsvpc", "RequiresCompatibilities": ["FARGATE"],
        "RuntimePlatform": {"CpuArchitecture": "X86_64", "OperatingSystemFamily": "LINUX"},
        "ExecutionRoleArn": attr(execution_role, "Arn"), "TaskRoleArn": attr(task_role, "Arn"),
        "ContainerDefinitions": containers, "Volumes": [{"Name": name} for name in volumes]},
        "Run a fixed image digest with ephemeral writable volumes", ["non-root containers", "no database master credentials", "default encrypted 20 GiB ephemeral storage"])


def service():
    data = template("DriveMate single-task Fargate API and WebSocket relay behind private ALB and CloudFront; reuse existing database, queue and artifacts.")
    data["Parameters"] = {
        "VpcId": {"Type": "AWS::EC2::VPC::Id"},
        "PublicRouteTableId": {"Type": "String", "AllowedPattern": "rtb-[a-f0-9]+"},
        "AlbSubnetIds": {"Type": "List<AWS::EC2::Subnet::Id>", "Description": "Two existing private subnets in different AZs, with spare ALB and CloudFront ENI addresses."},
        "TaskSubnetACidr": {"Type": "String", "Default": "10.41.30.0/24", "AllowedPattern": "10\\.41\\.[0-9]{1,3}\\.0/24"},
        "TaskSubnetBCidr": {"Type": "String", "Default": "10.41.31.0/24", "AllowedPattern": "10\\.41\\.[0-9]{1,3}\\.0/24"},
        "DbSecurityGroupId": {"Type": "AWS::EC2::SecurityGroup::Id"},
        "DbHost": {"Type": "String", "AllowedPattern": "[a-zA-Z0-9.-]+\\.rds\\.amazonaws\\.com"},
        "CloudFrontPrefixList": {"Type": "String", "AllowedPattern": "pl-[a-f0-9]+"},
        "ClusterArn": {"Type": "String", "AllowedPattern": "arn:aws:ecs:.*:cluster/.*"},
        "RepositoryArn": {"Type": "String", "AllowedPattern": "arn:aws:ecr:.*:repository/.*"},
        "ImageUri": {"Type": "String", "AllowedPattern": "[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com/[a-z0-9._/-]+@sha256:[a-f0-9]{64}"},
        "LogGroupName": {"Type": "String", "AllowedPattern": "[a-zA-Z0-9_./#-]+"},
        "DataBucket": {"Type": "String", "AllowedPattern": "[a-z0-9.-]{3,63}"},
        "ReleaseKey": {"Type": "String", "AllowedPattern": "releases/[a-zA-Z0-9._/-]+"},
        "ReleaseSha256": {"Type": "String", "AllowedPattern": "[a-f0-9]{64}"},
        "RagPointerKey": {"Type": "String", "AllowedPattern": "(?:releases/[a-zA-Z0-9._/-]+|data/rag/pointers/[a-f0-9]{64}\\.json)"},
        "RagPointerSha256": {"Type": "String", "AllowedPattern": "[a-f0-9]{64}"},
        "AppSecretArn": {"Type": "String", "AllowedPattern": "arn:aws:secretsmanager:.*"},
        "RefreshQueueUrl": {"Type": "String", "AllowedPattern": "https://sqs\\.[a-z0-9-]+\\.amazonaws\\.com/[0-9]{12}/[a-zA-Z0-9_-]+"},
        "RefreshQueueArn": {"Type": "String", "AllowedPattern": "arn:aws:sqs:.*"}}
    resources = data["Resources"]
    for label, zone in [("A", 0), ("B", 1)]:
        resources["TaskSubnet" + label] = resource("EC2::Subnet", {
            "VpcId": ref("VpcId"), "CidrBlock": ref("TaskSubnet" + label + "Cidr"),
            "AvailabilityZone": {"Fn::Select": [zone, {"Fn::GetAZs": ""}]}, "MapPublicIpOnLaunch": False},
            "Place replacement Fargate tasks in either AZ without a NAT gateway", ["explicit public task IP is for outbound calls", "no public CIDR ingress"])
        resources["TaskRoute" + label] = resource("EC2::SubnetRouteTableAssociation", {
            "SubnetId": ref("TaskSubnet" + label), "RouteTableId": ref("PublicRouteTableId")},
            "Reuse the existing internet gateway route for outbound SDK calls")
    resources["TaskSecurity"] = resource("EC2::SecurityGroup", {
        "VpcId": ref("VpcId"), "GroupDescription": "Fargate inbound from private ALB only",
        "SecurityGroupEgress": [{"IpProtocol": "tcp", "FromPort": 443, "ToPort": 443, "CidrIp": "0.0.0.0/0"},
                                {"IpProtocol": "tcp", "FromPort": 5432, "ToPort": 5432, "DestinationSecurityGroupId": ref("DbSecurityGroupId")}]},
        "Allow external HTTPS APIs and private PostgreSQL; keep public task address closed", ["no public CIDR ingress", "no SSH"])
    resources["AlbSecurity"] = resource("EC2::SecurityGroup", {
        "VpcId": ref("VpcId"), "GroupDescription": "Internal ALB from CloudFront origin-facing addresses only",
        "SecurityGroupIngress": [{"IpProtocol": "tcp", "FromPort": 80, "ToPort": 80, "SourcePrefixListId": ref("CloudFrontPrefixList")}],
        "SecurityGroupEgress": [{"IpProtocol": "tcp", "FromPort": 8080, "ToPort": 8080, "DestinationSecurityGroupId": ref("TaskSecurity")}]},
        "Only CloudFront may reach the private application listener", ["viewer HTTPS", "no internet-facing ALB"])
    resources["TaskIngress"] = resource("EC2::SecurityGroupIngress", {
        "GroupId": ref("TaskSecurity"), "IpProtocol": "tcp", "FromPort": 8080, "ToPort": 8080,
        "SourceSecurityGroupId": ref("AlbSecurity")}, "Route application requests through the private ALB only")
    resources["DatabaseIngress"] = resource("EC2::SecurityGroupIngress", {
        "GroupId": ref("DbSecurityGroupId"), "IpProtocol": "tcp", "FromPort": 5432, "ToPort": 5432,
        "SourceSecurityGroupId": ref("TaskSecurity")}, "Add Fargate access without replacing or editing existing database resources", ["TLS verify-full at client", "preserve existing ingress"])
    logs_arn = sub("arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:${LogGroupName}:log-stream:*")
    execution_statements = [
        statement(["ecr:GetAuthorizationToken"], "*"),
        statement(["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], ref("RepositoryArn")),
        statement(["logs:CreateLogStream", "logs:PutLogEvents"], logs_arn),
        statement(["secretsmanager:GetSecretValue"], ref("AppSecretArn"))]
    resources["ExecutionRole"] = role(execution_statements, "ECS injects selected application secret keys and pulls the immutable image")
    release_arn = sub("arn:${AWS::Partition}:s3:::${DataBucket}/${ReleaseKey}")
    resources["ApiTaskRole"] = role([statement(["s3:GetObject"], [
        release_arn, sub("arn:${AWS::Partition}:s3:::${DataBucket}/${RagPointerKey}"),
        sub("arn:${AWS::Partition}:s3:::${DataBucket}/data/cycles/latest.json")]),
        {**statement(["s3:ListBucket"], sub("arn:${AWS::Partition}:s3:::${DataBucket}")),
         "Condition": {"StringEquals": {"s3:prefix": "data/cycles/latest.json"}}}],
        "API reads approved artifacts and aggregate report only; cannot write datasets or consume jobs")
    resources["CycleTaskRole"] = role([
        statement(["s3:GetObject"], release_arn),
        statement(["s3:GetObject", "s3:PutObject"], sub("arn:${AWS::Partition}:s3:::${DataBucket}/data/cycles/*")),
        {**statement(["s3:ListBucket"], sub("arn:${AWS::Partition}:s3:::${DataBucket}")),
         "Condition": {"StringLike": {"s3:prefix": "data/cycles/*"}}},
        statement(["sqs:GetQueueAttributes", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility"], ref("RefreshQueueArn"))],
        "Separate one-shot cycle worker permissions from the interactive API")
    shared_env = {"AWS_REGION": ref("AWS::Region"), "DRIVEMATE_RELEASE_BUCKET": ref("DataBucket"),
                  "DRIVEMATE_RELEASE_KEY": ref("ReleaseKey"), "DRIVEMATE_RELEASE_SHA256": ref("ReleaseSha256")}
    api = container("api", {**shared_env, "DRIVEMATE_RAG_POINTER_KEY": ref("RagPointerKey"),
        "DRIVEMATE_RAG_POINTER_SHA256": ref("RagPointerSha256"), "DRIVEMATE_DB_HOST": ref("DbHost"),
        "DRIVEMATE_ANALYTICS_LATEST_KEY": "data/cycles/latest.json", "DRIVEMATE_ALLOW_LLM": "true",
        "DRIVEMATE_LLM_DAILY_LIMIT": "20", "SPRING_SQL_INIT_MODE": "never"},
        [secret(name) for name in ["DRIVEMATE_DB_PASSWORD", "OPENAI_API_KEY", "OPENAI_MODEL", "DRIVEMATE_KNOWLEDGE_ALLOWED_EMAILS"]])
    api["HealthCheck"] = {"Command": ["CMD", "/opt/drivemate/venv/bin/python", "/opt/drivemate/container/healthcheck.py", "api"],
                          "Interval": 15, "Timeout": 5, "Retries": 3, "StartPeriod": 120}
    api["MountPoints"] = [{"SourceVolume": "runtime", "ContainerPath": "/opt/drivemate/runtime"},
                          {"SourceVolume": "web", "ContainerPath": "/srv/drivemate-web"},
                          {"SourceVolume": "api-tmp", "ContainerPath": "/tmp"}]
    nginx = container("nginx", {})
    nginx["DependsOn"] = [{"ContainerName": "api", "Condition": "HEALTHY"}]
    nginx["StartTimeout"] = 120
    nginx["PortMappings"] = [{"ContainerPort": 8080, "Protocol": "tcp"}]
    nginx["HealthCheck"] = {"Command": ["CMD", "/opt/drivemate/venv/bin/python", "/opt/drivemate/container/healthcheck.py", "nginx"],
                            "Interval": 15, "Timeout": 5, "Retries": 3, "StartPeriod": 15}
    nginx["MountPoints"] = [{"SourceVolume": "web", "ContainerPath": "/srv/drivemate-web", "ReadOnly": True},
                            {"SourceVolume": "nginx-tmp", "ContainerPath": "/tmp"}]
    resources["ApiTask"] = task_definition("api", "ExecutionRole", "ApiTaskRole", [api, nginx], ["runtime", "web", "api-tmp", "nginx-tmp"])
    cycle = container("cycle", {**shared_env, "DRIVEMATE_CYCLE_QUEUE_URL": ref("RefreshQueueUrl"),
        "DRIVEMATE_DATA_BUCKET": ref("DataBucket")}, [secret("ONBID_SERVICE_KEY")])
    cycle["MountPoints"] = [{"SourceVolume": "runtime", "ContainerPath": "/opt/drivemate/runtime"},
                            {"SourceVolume": "cycle-tmp", "ContainerPath": "/tmp"}]
    resources["CycleTask"] = task_definition("cycle", "ExecutionRole", "CycleTaskRole", [cycle], ["runtime", "cycle-tmp"], memory="3072")
    resources["LoadBalancer"] = resource("ElasticLoadBalancingV2::LoadBalancer", {
        "Type": "application", "Scheme": "internal", "IpAddressType": "ipv4",
        "Subnets": ref("AlbSubnetIds"), "SecurityGroups": [ref("AlbSecurity")],
        "LoadBalancerAttributes": [{"Key": "idle_timeout.timeout_seconds", "Value": "130"},
                                   {"Key": "routing.http.drop_invalid_header_fields.enabled", "Value": "true"}]},
        "Private ALB routes CloudFront HTTP and WebSocket traffic to Fargate", ["two AZ subnets", "no public listener"])
    resources["Targets"] = resource("ElasticLoadBalancingV2::TargetGroup", {
        "VpcId": ref("VpcId"), "Port": 8080, "Protocol": "HTTP", "TargetType": "ip",
        "HealthCheckPath": "/api/v1/health", "HealthCheckIntervalSeconds": 15, "HealthCheckTimeoutSeconds": 5,
        "HealthyThresholdCount": 2, "UnhealthyThresholdCount": 3, "Matcher": {"HttpCode": "200"},
        "TargetGroupAttributes": [{"Key": "deregistration_delay.timeout_seconds", "Value": "15"}]},
        "Check API readiness through Nginx before routing requests", ["Fargate uses IP targets"])
    resources["Listener"] = resource("ElasticLoadBalancingV2::Listener", {
        "LoadBalancerArn": ref("LoadBalancer"), "Port": 80, "Protocol": "HTTP",
        "DefaultActions": [{"Type": "forward", "TargetGroupArn": ref("Targets")}]},
        "CloudFront connects over the private VPC path")
    resources["Service"] = resource("ECS::Service", {
        "Cluster": ref("ClusterArn"), "TaskDefinition": ref("ApiTask"), "LaunchType": "FARGATE",
        "PlatformVersion": "1.4.0", "DesiredCount": 1, "EnableExecuteCommand": False,
        "AvailabilityZoneRebalancing": "DISABLED", "HealthCheckGracePeriodSeconds": 180,
        "DeploymentConfiguration": {"MinimumHealthyPercent": 0, "MaximumPercent": 100,
                                    "DeploymentCircuitBreaker": {"Enable": True, "Rollback": True}},
        "NetworkConfiguration": {"AwsvpcConfiguration": {"AssignPublicIp": "ENABLED",
            "Subnets": [ref("TaskSubnetA"), ref("TaskSubnetB")], "SecurityGroups": [ref("TaskSecurity")]}},
        "LoadBalancers": [{"ContainerName": "nginx", "ContainerPort": 8080, "TargetGroupArn": ref("Targets")}],
        "EnableECSManagedTags": True, "PropagateTags": "SERVICE", "Tags": [{"Key": "Project", "Value": "DriveMate"}]},
        "Recover failed tasks in either AZ; keep exactly one process for same-account location relay",
        ["one task, no autoscaling", "stop-first deployment causes brief disconnect", "rollback requires a previous completed deployment"],
        DependsOn=["Listener", "TaskIngress", "DatabaseIngress", "TaskRouteA", "TaskRouteB"])
    resources["VpcOrigin"] = resource("CloudFront::VpcOrigin", {"VpcOriginEndpointConfig": {
        "Arn": ref("LoadBalancer"), "Name": sub("${AWS::StackName}-origin"),
        "HTTPPort": 80, "HTTPSPort": 443, "OriginProtocolPolicy": "http-only"}},
        "Use private ALB connectivity for viewer HTTPS and WebSocket requests", ["existing VPC must have internet gateway attached"], DependsOn="Listener")
    resources["Distribution"] = resource("CloudFront::Distribution", {"DistributionConfig": {
        "Enabled": True, "Comment": "DriveMate Fargate HTTPS application", "DefaultRootObject": "index.html",
        "HttpVersion": "http2and3", "IPV6Enabled": True, "PriceClass": "PriceClass_All",
        "Origins": [{"Id": "App", "DomainName": attr("LoadBalancer", "DNSName"), "VpcOriginConfig": {
            "VpcOriginId": attr("VpcOrigin", "Id"), "OriginReadTimeout": 120, "OriginKeepaliveTimeout": 5}}],
        "DefaultCacheBehavior": {"TargetOriginId": "App", "ViewerProtocolPolicy": "redirect-to-https",
            "AllowedMethods": ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"],
            "CachedMethods": ["GET", "HEAD"], "Compress": True,
            "CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
            "OriginRequestPolicyId": "216adef6-5c7f-47e4-b989-5492eafa07d3"},
        "ViewerCertificate": {"CloudFrontDefaultCertificate": True}}},
        "Managed HTTPS with authenticated responses never cached", ["forward viewer Host, Authorization and WebSocket headers", "no original document data in static assets"])
    data["Outputs"] = {
        "ServiceName": output(attr("Service", "Name"), "Single-task ECS API service"),
        "ServiceArn": output(ref("Service"), "ECS service ARN"),
        "TaskDefinitionArn": output(ref("ApiTask"), "Active API task definition"),
        "CycleTaskDefinitionArn": output(ref("CycleTask"), "One-shot cycle task; no continuous service or schedule created"),
        "ExecutionRoleArn": output(attr("ExecutionRole", "Arn"), "ECS image, logs and secret injection role"),
        "ApiTaskRoleArn": output(attr("ApiTaskRole", "Arn"), "Artifact-read-only API role"),
        "CycleTaskRoleArn": output(attr("CycleTaskRole", "Arn"), "SQS consumer and cycle artifact writer role"),
        "TaskSubnetIds": output({"Fn::Join": [",", [ref("TaskSubnetA"), ref("TaskSubnetB")]]}, "Outbound-capable task subnets"),
        "TaskSecurityGroupId": output(ref("TaskSecurity"), "ALB-only task ingress"),
        "LoadBalancerArn": output(ref("LoadBalancer"), "Private application load balancer"),
        "DistributionId": output(ref("Distribution"), "CloudFront distribution"),
        "WebUrl": output(sub("https://${Distribution.DomainName}"), "Application HTTPS address")}
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", choices=["foundation", "service", "all"], default="all")
    args = parser.parse_args()
    for name, build in {"foundation": foundation, "service": service}.items():
        if args.only in (name, "all"):
            destination = HERE / ("ecs-" + name + ".json")
            destination.write_text(json.dumps(build(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
