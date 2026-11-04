# Deployment validation

Checkpoint: **November 4, 2026, ECS service not yet created**. Validation of the existing EC2 baseline and the new container runtime is complete at the scopes below. This is not a successful ECS deployment report.

## Existing AWS baseline

The EC2 application stack reached `CREATE_COMPLETE`. Bootstrap prepared the RDS schema, imported six documents/83 chunks into pgvector and initialized the owner account. Spring/Nginx readiness and the RAG initialization process succeeded.

Public HTTPS checks passed for owner authentication, reserved-email registration 403, 14,867-row candidate analytics with no model promotion, supported ML template inference, pgvector document retrieval and non-owner RAG 403. The serving model remains the validated model trained from 2,197 cleaned rows. The extra 54,815 imported records produced 14,867 clean rows for candidate evaluation; they did not replace that serving model or the 83-chunk RAG collection.

Public WebSocket checks passed with synthetic positions: two sessions of one temporary account exchanged position/stop messages, another temporary account received none, and temporary accounts were deleted. The smoke helper compares normalized timestamps by instant. This validates the relay route, not real GPS hardware or background mobile tracking.

RAG used `use_llm=false`: query embedding usage occurred, while generated LLM explanations were not requested. These AWS baseline checks do not establish a new cloud LLM-answer evaluation.

## Container and infrastructure preparation

- The local final runtime image contains code and dependencies, excluding models, raw data, RAG corpus/vectors, keys and account configuration. Ten unit checks cover download checksums, bounded/safe ZIP extraction, image-code preservation, metadata-only pointers, no candidate promotion and exact-key aggregate refresh.
- An actual local container ran as UID 10001 with all Linux capabilities dropped and a read-only root filesystem. Named runtime/web/tmp volumes were writable as required. Spring with synthetic H2 data, Nginx/static web and Nginx WebSocket relay/isolation/stop all passed.
- ECS cluster and ECR creation completed. The initial foundation's role-propagation failure was recovered by retaining and importing ECR/log resources into the completed v2 foundation. CloudWatch retention is 14 days.
- The target is one 1-vCPU/3-GiB Fargate API task, separate Nginx container, ALB and CloudFront. ECS service creation, actual task readiness, new public-route verification and log delivery are still pending at this checkpoint.
- The separate cycle task uses the existing worker's `--once` behavior. Its complete AWS refresh path and weekly schedule are not yet verified. No model promotion is automatic.
- Kubernetes rendering is validated; there is no deployed Kubernetes cluster.

Prior EC2 `foundation.json`/`application.json` lint and selected AWS Guard checks remain historical validation of those templates. They do not prove the new ECS templates or deployed service are healthy. Record new ECS template results and post-deployment checks separately.

## Explicit limits and blocked activation

RDS PostgreSQL 18.6 runs on `db.t4g.micro`, Single-AZ with one-day backups, as selected by the user. Keep the explicit `RDS_MULTI_AZ_SUPPORT` exception visible; this configuration has no automatic standby failover. Do not report an unconditional availability-control pass.

The ordinary API runtime uses the application DB credential and never receives the master secret or owner bootstrap password. Schema initialization is disabled. The existing application DB role still owns schema/tables, so DML-only database privileges have not been established.

GitHub OIDC provider `Get`/`List` calls are denied by organization SCP `p-5httx2mw`; automatic CD activation is blocked. Successful CI, ECR preparation and local Docker checks do not remove that restriction.

The estimated Fargate compute component is about US$47/month; RDS, ALB, storage, traffic, logs and external API usage are additional. The user's KRW 200,000 monthly target is not a spending cap. Validate actual costs after deployment and retain historical snapshot/key storage costs in that accounting.

The earlier SQS policy correction, DB creation dependency and account-confirmed CloudFront 120-second response timeout remain part of the EC2 baseline history. The Python worker deadline is 115 seconds. Actual ECS request and long-running-worker behavior must be verified after the service starts.

See [current execution checkpoint](DEPLOYMENT-STATUS.md) for pending steps and [runtime configuration](../containers/README.md) for container roles and secret boundaries.
