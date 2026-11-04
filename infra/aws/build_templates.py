"""Generate reviewable CloudFormation JSON; no AWS calls or credentials."""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
def ref(name): return {"Ref": name}
def sub(value): return {"Fn::Sub": value}
def attr(name, key): return {"Fn::GetAtt": [name, key]}
def resource(kind, properties, why, must=(), **extra):
    return {"Type": "AWS::" + kind, "Metadata": {"com.aws.cloudformation.Context": {"why": why, "must": list(must)}}, "Properties": properties, **extra}
def template(description):
    return {"AWSTemplateFormatVersion": "2010-09-09", "Description": description,
            "Metadata": {"AWSToolsMetrics": {"AWSAgentToolkit": "aws-cloudformation@3"}}, "Resources": {}}
def output(value, description): return {"Value": value, "Description": description}

def foundation():
    data = template("DriveMate durable private artifacts and secrets; retained independently from compute.")
    r = data["Resources"]
    r["Data"] = resource("S3::Bucket", {
        "PublicAccessBlockConfiguration": dict(BlockPublicAcls=True, IgnorePublicAcls=True, BlockPublicPolicy=True, RestrictPublicBuckets=True),
        "BucketEncryption": {"ServerSideEncryptionConfiguration": [{"ServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}}]},
        "VersioningConfiguration": {"Status": "Enabled"},
        "LifecycleConfiguration": {"Rules": [{"Id": "IncompleteUploads", "Status": "Enabled", "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 3}}]},
        "Tags": [{"Key": "Project", "Value": "DriveMate"}]}, "Original data and immutable releases survive compute replacement", ["private", "encrypted", "retain"], DeletionPolicy="Retain", UpdateReplacePolicy="Retain")
    r["DataPolicy"] = resource("S3::BucketPolicy", {"Bucket": ref("Data"), "PolicyDocument": {"Version": "2012-10-17", "Statement": [{"Effect": "Deny", "Principal": "*", "Action": "s3:*", "Resource": [attr("Data", "Arn"), sub("${Data.Arn}/*")], "Condition": {"Bool": {"aws:SecureTransport": "false"}}}]}}, "Reject plaintext object access", ["TLS required"])
    r["AppSecret"] = resource("SecretsManager::Secret", {"Description": "DriveMate API credentials; populated out of band", "SecretString": "{}"}, "Credentials never enter templates or release artifacts", ["retain on replacement"], DeletionPolicy="Retain", UpdateReplacePolicy="Retain")
    data["Outputs"] = {"DataBucket": output(ref("Data"), "Private artifact bucket"), "AppSecretArn": output(ref("AppSecret"), "API secret ARN; never the value")}
    return data

def application():
    data = template("DriveMate Spring API, CPU ML and document RAG with private PostgreSQL and a repeatable SQS data cycle; current Free plan uses one database AZ.")
    data["Parameters"] = {
        "DataBucket": {"Type": "String", "AllowedPattern": "[a-z0-9.-]{3,63}"},
        "AppSecretArn": {"Type": "String", "AllowedPattern": "arn:aws:secretsmanager:.*"},
        "ReleaseKey": {"Type": "String", "AllowedPattern": "releases/[a-zA-Z0-9._/-]+"},
        "ReleaseSha256": {"Type": "String", "AllowedPattern": "[a-f0-9]{64}"},
        "BootstrapKey": {"Type": "String", "AllowedPattern": "releases/[a-zA-Z0-9._/-]+"},
        "BootstrapSha256": {"Type": "String", "AllowedPattern": "[a-f0-9]{64}"},
        "ImageId": {"Type": "AWS::EC2::Image::Id"},
        "CloudFrontPrefixList": {"Type": "String", "AllowedPattern": "pl-[a-f0-9]+"},
        "EnableSchedule": {"Type": "String", "AllowedValues": ["ENABLED", "DISABLED"], "Default": "DISABLED"},
        "DeployCompute": {"Type": "String", "AllowedValues": ["true", "false"], "Default": "true"},
        "BackupRetentionDays": {"Type": "Number", "AllowedValues": [1, 7, 14], "Default": 1, "Description": "Use 1 for the current Free plan; 7 is the paid-plan target."},
    }
    data['Conditions'] = {'ComputeEnabled': {'Fn::Equals': [ref('DeployCompute'), 'true']}}
    r = data["Resources"]
    r["Vpc"] = resource("EC2::VPC", {"CidrBlock": "10.41.0.0/16", "EnableDnsSupport": True, "EnableDnsHostnames": True}, "Isolate application and database traffic")
    r["Gateway"] = resource("EC2::InternetGateway", {}, "Outbound API and package access")
    r["GatewayAttachment"] = resource("EC2::VPCGatewayAttachment", {"VpcId": ref("Vpc"), "InternetGatewayId": ref("Gateway")}, "CloudFront VPC origin requires attached gateway")
    for name, cidr, zone in [("AppSubnet", "10.41.1.0/24", 0), ("DbSubnetA", "10.41.10.0/24", 0), ("DbSubnetB", "10.41.20.0/24", 1)]:
        r[name] = resource("EC2::Subnet", {"VpcId": ref("Vpc"), "CidrBlock": cidr, "AvailabilityZone": {"Fn::Select": [zone, {"Fn::GetAZs": ""}]}, "MapPublicIpOnLaunch": False}, "Separate application egress and database subnets", ["database subnets have no internet route"])
    r["AppRoutes"] = resource("EC2::RouteTable", {"VpcId": ref("Vpc")}, "Only application host needs internet egress")
    r["EgressRoute"] = resource("EC2::Route", {"RouteTableId": ref("AppRoutes"), "DestinationCidrBlock": "0.0.0.0/0", "GatewayId": ref("Gateway")}, "Reach Onbid and OpenAI without a separate NAT gateway", DependsOn="GatewayAttachment")
    r["AppRouteAssociation"] = resource("EC2::SubnetRouteTableAssociation", {"SubnetId": ref("AppSubnet"), "RouteTableId": ref("AppRoutes")}, "Explicit egress subnet")
    r["AppSecurity"] = resource("EC2::SecurityGroup", {"GroupDescription": "CloudFront origin only; no SSH or direct API ingress", "VpcId": ref("Vpc"), "SecurityGroupIngress": [{"IpProtocol": "tcp", "FromPort": 80, "ToPort": 80, "SourcePrefixListId": ref("CloudFrontPrefixList")}], "SecurityGroupEgress": [{"IpProtocol": "-1", "CidrIp": "0.0.0.0/0"}]}, "CloudFront VPC connection carries viewer requests; public address used for outbound calls", ["no public CIDR ingress", "Spring binds loopback", "SSH closed"])
    r["DbSecurity"] = resource("EC2::SecurityGroup", {"GroupDescription": "PostgreSQL from application only", "VpcId": ref("Vpc"), "SecurityGroupIngress": [{"IpProtocol": "tcp", "FromPort": 5432, "ToPort": 5432, "SourceSecurityGroupId": ref("AppSecurity")}]}, "Restrict database access", ["no public DB ingress"])
    r["DbSubnets"] = resource("RDS::DBSubnetGroup", {"DBSubnetGroupDescription": "Private database subnets in two AZs", "SubnetIds": [ref("DbSubnetA"), ref("DbSubnetB")]}, "Multi-AZ database placement")
    r["DbParameters"] = resource("RDS::DBParameterGroup", {"Family": "postgres18", "Description": "TLS required", "Parameters": {"rds.force_ssl": "1"}}, "Encrypt database connections", ["verify-full in application client"])
    r["Database"] = resource("RDS::DBInstance", {"Engine": "postgres", "EngineVersion": "17.11", "DBInstanceClass": "db.t4g.small", "DBName": "drivemate", "MasterUsername": "drivemate_admin", "ManageMasterUserPassword": True, "AllocatedStorage": "20", "MaxAllocatedStorage": 30, "StorageType": "gp3", "StorageEncrypted": True, "MultiAZ": True, "PubliclyAccessible": False, "BackupRetentionPeriod": 7, "DeletionProtection": True, "AutoMinorVersionUpgrade": True, "DBSubnetGroupName": ref("DbSubnets"), "DBParameterGroupName": ref("DbParameters"), "VPCSecurityGroups": [ref("DbSecurity")], "EnableCloudwatchLogsExports": ["postgresql"], "CopyTagsToSnapshot": True, "Tags": [{"Key": "Project", "Value": "DriveMate"}]}, "Persistent accounts and pgvector documents; standby for automatic database failover", ["encrypted", "private", "retain", "backups enabled"], DeletionPolicy="Retain", UpdateReplacePolicy="Retain")
    r["DeadLetters"] = resource("SQS::Queue", {"MessageRetentionPeriod": 1209600, "SqsManagedSseEnabled": True}, "Keep failed refresh jobs for investigation", ["no silent failed-job deletion"], DeletionPolicy="Retain", UpdateReplacePolicy="Retain")
    r["DataKey"] = resource("KMS::Key", {"Description": "DriveMate database and logs encryption", "EnableKeyRotation": True, "KeyPolicy": {"Version": "2012-10-17", "Statement": [
        {"Effect": "Allow", "Principal": {"AWS": sub("arn:${AWS::Partition}:iam::${AWS::AccountId}:root")}, "Action": "kms:*", "Resource": "*"},
        {"Effect": "Allow", "Principal": {"Service": sub("logs.${AWS::Region}.amazonaws.com")}, "Action": ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:DescribeKey"], "Resource": "*", "Condition": {"ArnLike": {"kms:EncryptionContext:aws:logs:arn": sub("arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/rds/instance/${AWS::StackName}-postgres-v2/*")}}}
    ]}}, "Customer-managed key for database and query logs", ["retain key while encrypted data exists"], DeletionPolicy="Retain", UpdateReplacePolicy="Retain")
    r["Database"]["Properties"].update({"EngineVersion": "18.6", "DBInstanceClass": "db.t4g.micro", "MultiAZ": False, "DBInstanceIdentifier": sub("${AWS::StackName}-postgres-v2"), "KmsKeyId": attr("DataKey", "Arn"), "EnablePerformanceInsights": True, "PerformanceInsightsRetentionPeriod": 7, "PerformanceInsightsKMSKeyId": attr("DataKey", "Arn")})
    r["Database"]["Metadata"]["com.aws.cloudformation.Context"]["why"] = "Persistent accounts and pgvector documents; user-selected Free plan requires micro, Single-AZ and one-day backup; no automatic standby failover; v2 identifier preserves prior database log history"
    r["Database"]["Properties"]["BackupRetentionPeriod"] = ref('BackupRetentionDays')
    r["Database"]["Properties"]["Tags"].extend([{"Key": "created_by", "Value": "rds-oss-skill"}, {"Key": "generation_model", "Value": "GPT-6"}])
    r["DatabaseLogs"] = resource("Logs::LogGroup", {"LogGroupName": sub("/aws/rds/instance/${AWS::StackName}-postgres-v2/postgresql"), "RetentionInDays": 14, "KmsKeyId": attr("DataKey", "Arn")}, "Encrypt database logs and bound retention", ["do not log application payloads"])
    r["Database"]["DependsOn"] = "DatabaseLogs"
    r["RefreshQueue"] = resource("SQS::Queue", {"VisibilityTimeout": 900, "ReceiveMessageWaitTimeSeconds": 20, "SqsManagedSseEnabled": True, "RedrivePolicy": {"deadLetterTargetArn": attr("DeadLetters", "Arn"), "maxReceiveCount": 3}}, "Separate scheduled collection from interactive inference", ["worker renews visibility", "idempotent completion marker"])
    r["WeeklyRefresh"] = resource("Events::Rule", {"ScheduleExpression": "cron(0 17 ? * SUN *)", "State": ref("EnableSchedule"), "Targets": [{"Id": "Refresh", "Arn": attr("RefreshQueue", "Arn"), "Input": '{"kind":"refresh","schema_version":1}'}]}, "Weekly Monday 02:00 KST data refresh; enable after validation", ["candidate models never auto-promoted"])
    r["QueuePolicy"] = resource("SQS::QueuePolicy", {"Queues": [ref("RefreshQueue"), ref("DeadLetters")], "PolicyDocument": {"Version": "2012-10-17", "Statement": [{"Effect": "Deny", "Principal": "*", "Action": "sqs:*", "Resource": [attr("RefreshQueue", "Arn"), attr("DeadLetters", "Arn")], "Condition": {"Bool": {"aws:SecureTransport": "false"}}}, {"Effect": "Allow", "Principal": {"Service": "events.amazonaws.com"}, "Action": "sqs:SendMessage", "Resource": attr("RefreshQueue", "Arn"), "Condition": {"ArnEquals": {"aws:SourceArn": attr("WeeklyRefresh", "Arn")}, "StringEquals": {"aws:SourceAccount": ref("AWS::AccountId")}}}]}}, "Only this schedule may enqueue scheduled jobs", ["TLS required"])
    r["Logs"] = resource("Logs::LogGroup", {"RetentionInDays": 14}, "Bound operational log storage", ["no credentials or request bodies"])
    # SQS rejects statements with multiple resources, even when CloudFormation
    # accepts the IAM-shaped JSON. Each queue receives its own scoped document.
    r["QueuePolicy"]["Properties"]["Queues"] = [ref("RefreshQueue")]
    r["QueuePolicy"]["Properties"]["PolicyDocument"]["Statement"][0]["Resource"] = attr("RefreshQueue", "Arn")
    r["DeadLetterPolicy"] = resource("SQS::QueuePolicy", {"Queues": [ref("DeadLetters")], "PolicyDocument": {"Version": "2012-10-17", "Statement": [{"Effect": "Deny", "Principal": "*", "Action": "sqs:*", "Resource": attr("DeadLetters", "Arn"), "Condition": {"Bool": {"aws:SecureTransport": "false"}}}]}}, "Require TLS for the retained failed-job queue", ["one resource per SQS statement"])
    r["Database"]["DependsOn"] = ["DatabaseLogs", "QueuePolicy", "DeadLetterPolicy"]
    r["HostRole"] = resource("IAM::Role", {"AssumeRolePolicyDocument": {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Principal": {"Service": "ec2.amazonaws.com"}, "Action": "sts:AssumeRole"}]}, "ManagedPolicyArns": ["arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"], "Policies": [{"PolicyName": "Runtime", "PolicyDocument": {"Version": "2012-10-17", "Statement": [
        {"Effect": "Allow", "Action": ["s3:GetObject"], "Resource": [sub("arn:${AWS::Partition}:s3:::${DataBucket}/releases/*")]},
        {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject"], "Resource": [sub("arn:${AWS::Partition}:s3:::${DataBucket}/data/*")]},
        {"Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": sub("arn:${AWS::Partition}:s3:::${DataBucket}"), "Condition": {"StringLike": {"s3:prefix": ["releases/*", "data/*"]}}},
        {"Effect": "Allow", "Action": ["secretsmanager:GetSecretValue"], "Resource": [ref("AppSecretArn"), attr("Database", "MasterUserSecret.SecretArn")]},
        {"Effect": "Allow", "Action": ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"], "Resource": attr("RefreshQueue", "Arn")},
        {"Effect": "Allow", "Action": ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"], "Resource": attr("Logs", "Arn")},
        {"Effect": "Allow", "Action": ["cloudformation:SignalResource"], "Resource": ref("AWS::StackId")},
    ]}}]}, "Instance credentials instead of stored AWS keys", ["scoped data prefixes and queues", "no administrative credentials"])
    r["HostProfile"] = resource("IAM::InstanceProfile", {"Roles": [ref("HostRole")]}, "Attach scoped role")
    replacements = {"REGION": "${AWS::Region}", "BUCKET": "${DataBucket}", "RELEASE_KEY": "${ReleaseKey}", "RELEASE_SHA256": "${ReleaseSha256}", "DB_HOST": "${Database.Endpoint.Address}", "DB_SECRET_ARN": "${Database.MasterUserSecret.SecretArn}", "APP_SECRET_ARN": "${AppSecretArn}", "QUEUE_URL": "${RefreshQueue}"}
    replacements['STACK_NAME'] = '${AWS::StackName}'
    replacements['LOG_GROUP'] = '${Logs}'
    bootstrap = '''#!/bin/bash
set -euo pipefail
umask 077
export DEBIAN_FRONTEND=noninteractive
apt-get -o DPkg::Lock::Timeout=120 update
apt-get -o DPkg::Lock::Timeout=120 install -y --no-install-recommends python3-boto3
python3 - <<'PY'
import boto3, hashlib, json, pathlib, subprocess
from botocore.config import Config
values = json.loads(REPLACEMENTS)
client = boto3.client('s3', region_name=values['REGION'], config=Config(connect_timeout=10, read_timeout=60, retries={'total_max_attempts':5,'mode':'standard'}))
folder = pathlib.Path('/var/lib/drivemate-bootstrap')
folder.mkdir(mode=0o700, parents=True, exist_ok=True)
path = folder / 'bootstrap.tpl'
client.download_file(values['BUCKET'], '${BootstrapKey}', str(path))
content = path.read_bytes()
if hashlib.sha256(content).hexdigest() != '${BootstrapSha256}':
    raise SystemExit('Bootstrap checksum mismatch')
script = content.decode('utf-8')
for key, value in values.items():
    script = script.replace('@@' + key + '@@', value)
target = folder / 'bootstrap.sh'
target.write_text(script)
target.chmod(0o700)
subprocess.run(['bash',str(target)],check=True)
PY
'''.replace('REPLACEMENTS', repr(json.dumps(replacements)))
    r["Host"] = resource("EC2::Instance", {"ImageId": ref("ImageId"), "InstanceType": "t3.medium", "IamInstanceProfile": ref("HostProfile"), "NetworkInterfaces": [{"DeviceIndex": "0", "SubnetId": ref("AppSubnet"), "GroupSet": [ref("AppSecurity")], "AssociatePublicIpAddress": True}], "MetadataOptions": {"HttpTokens": "required", "HttpPutResponseHopLimit": 1}, "CreditSpecification": {"CPUCredits": "standard"}, "BlockDeviceMappings": [{"DeviceName": "/dev/sda1", "Ebs": {"VolumeSize": 30, "VolumeType": "gp3", "Encrypted": True, "DeleteOnTermination": True}}], "UserData": {"Fn::Base64": sub(bootstrap)}, "Tags": [{"Key": "Name", "Value": sub("${AWS::StackName}-app")}, {"Key": "Project", "Value": "DriveMate"}]}, "One CPU application host keeps fixed costs bounded; systemd restarts failed processes", ["no user data on ephemeral host", "IMDSv2 required", "standard CPU credits"], DependsOn="EgressRoute")
    r["VpcOrigin"] = resource("CloudFront::VpcOrigin", {"VpcOriginEndpointConfig": {"Arn": sub("arn:${AWS::Partition}:ec2:${AWS::Region}:${AWS::AccountId}:instance/${Host}"), "Name": sub("${AWS::StackName}-origin"), "HTTPPort": 80, "HTTPSPort": 443, "OriginProtocolPolicy": "http-only"}}, "Private origin path avoids public inbound application exposure", ["viewer HTTPS", "origin limited to CloudFront"], DependsOn="GatewayAttachment")
    r["Host"]["Properties"]["InstanceType"] = "c7i-flex.large"
    del r["Host"]["Properties"]["CreditSpecification"]
    r["Host"]["DependsOn"] = ["EgressRoute", "AppRouteAssociation"]
    r["Host"]["Metadata"]["com.aws.cloudformation.Context"] = {"why": "Free-plan eligible 2-vCPU/4-GiB application host; CPU inference avoids a continuously billed GPU", "must": ["no user data on ephemeral host", "IMDSv2 required", "outbound routing ready before bootstrap"]}
    r["Host"]["CreationPolicy"] = {"ResourceSignal": {"Count": 1, "Timeout": "PT30M"}}
    r["Distribution"] = resource("CloudFront::Distribution", {"DistributionConfig": {"Enabled": True, "Comment": "DriveMate HTTPS application", "DefaultRootObject": "index.html", "HttpVersion": "http2and3", "IPV6Enabled": True, "PriceClass": "PriceClass_All", "Origins": [{"Id": "App", "DomainName": attr("Host", "PrivateDnsName"), "VpcOriginConfig": {"VpcOriginId": attr("VpcOrigin", "Id"), "OriginReadTimeout": 60, "OriginKeepaliveTimeout": 5}}], "DefaultCacheBehavior": {"TargetOriginId": "App", "ViewerProtocolPolicy": "redirect-to-https", "AllowedMethods": ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"], "CachedMethods": ["GET", "HEAD"], "Compress": True, "CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad", "OriginRequestPolicyId": "216adef6-5c7f-47e4-b989-5492eafa07d3"}, "ViewerCertificate": {"CloudFrontDefaultCertificate": True}}}, "Managed HTTPS address without purchasing a domain", ["cache disabled for authenticated data", "Authorization and viewer host forwarded"])
    r["HostRecovery"] = resource("CloudWatch::Alarm", {"AlarmDescription": "Recover host after underlying system failure", "Namespace": "AWS/EC2", "MetricName": "StatusCheckFailed_System", "Dimensions": [{"Name": "InstanceId", "Value": ref("Host")}], "Statistic": "Maximum", "Period": 60, "EvaluationPeriods": 2, "Threshold": 1, "ComparisonOperator": "GreaterThanOrEqualToThreshold", "AlarmActions": [sub("arn:${AWS::Partition}:automate:${AWS::Region}:ec2:recover")]}, "Automatic recovery for supported hardware failures", ["not application-level multi-AZ availability"])
    r["QueueFailures"] = resource("CloudWatch::Alarm", {"AlarmDescription": "Refresh jobs require investigation", "Namespace": "AWS/SQS", "MetricName": "ApproximateNumberOfMessagesVisible", "Dimensions": [{"Name": "QueueName", "Value": attr("DeadLetters", "QueueName")}], "Statistic": "Maximum", "Period": 300, "EvaluationPeriods": 1, "Threshold": 1, "ComparisonOperator": "GreaterThanOrEqualToThreshold", "TreatMissingData": "notBreaching"}, "Expose failures in monitoring; no unsolicited messaging")
    data["Outputs"] = {"Url": output(sub("https://${Distribution.DomainName}"), "Application HTTPS URL"), "HostId": output(ref("Host"), "SSM managed host"), "DatabaseHost": output(attr("Database", "Endpoint.Address"), "Private PostgreSQL endpoint"), "DatabaseSecret": output(attr("Database", "MasterUserSecret.SecretArn"), "RDS-managed credential ARN"), "QueueUrl": output(ref("RefreshQueue"), "Refresh job queue"), "DistributionId": output(ref("Distribution"), "CloudFront distribution"), "LogGroup": output(ref("Logs"), "Operational logs")}
    r["Distribution"]["Properties"]["DistributionConfig"]["Origins"][0]["VpcOriginConfig"]["OriginReadTimeout"] = 120
    for name in ['Host', 'VpcOrigin', 'Distribution', 'HostRecovery']: r[name]['Condition'] = 'ComputeEnabled'
    for name in ['Url', 'HostId', 'DistributionId']: data['Outputs'][name]['Condition'] = 'ComputeEnabled'
    return data

def main():
    for name, value in [("foundation", foundation()), ("application", application())]:
        # IAM Bool values support JSON booleans; preserve types for Guard checks.
        def normalize(node):
            if isinstance(node, dict):
                for key, child in node.items():
                    if key == "aws:SecureTransport" and child == "false": node[key] = False
                    else: normalize(child)
            elif isinstance(node, list):
                for child in node: normalize(child)
        normalize(value)
        target = HERE / (name + ".json")
        target.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(name, target.stat().st_size, "bytes", len(value["Resources"]), "resources")
if __name__ == "__main__": main()
