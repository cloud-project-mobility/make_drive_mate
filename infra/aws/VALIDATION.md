# Deployment validation

Checkpoint: **November 4, 2026, ECS API revision 2 and Nginx healthy; CloudFront deployed; service stack UPDATE_COMPLETE**. The full public HTTPS/WSS smoke passed at `https://d2a3l7qimjk3ir.cloudfront.net`. Temporary EC2, its old CloudFront distribution and VPC origin are deleted. Historical baseline and final ECS results are distinguished below.

## Final ECS public route

The full smoke completed in one observed 15.249-second run: health/login 200; supported-vehicle ML template; RDS pgvector retrieval with six sources; non-owner RAG and reserved-owner-email registration both 403; same-account synthetic WSS relay and stop; zero positions delivered to the other account. The two temporary accounts were deleted and the smoke's owner session was revoked. No real device location was read. RAG made a query embedding request with `use_llm=false`; generated LLM explanations were not requested. This is a functional check, not a latency benchmark or new LLM-answer evaluation.

The public API's latest report matches S3 run `20261104T111517Z-6ac82deb`: 2,187 cleaned rows, `onbid-api-v1`, `complete_scope=api_collection` and `upstream_collection_verified=true`. New candidates remain unpromoted. The 14,867-row historical candidate is preserved separately, and the serving model remains the validated 2,197-row model.

The subsequent authorized [10-scenario RAG evaluation](../../docs/RAG-EVALUATION-20261104.md) is separate from the no-LLM smoke above. All requests returned 200: eight GPT-backed answers and two out-of-scope abstentions without LLM calls. All eight answered cases preserved exact source quotes. The predefined automatic rubric passed 8/10; additional source review found eight answers relevant/sufficient and both abstentions appropriate. Q04/Q07 used valid alternative documents excluded by the fixed-document rubric; the original automatic score is retained. This is an author-written small scenario set, not general accuracy validation. Eight GPT calls used 18,696 input/363 output tokens; ten query embeddings used 333 input tokens. Mean/median/maximum request latency was 3.2562/3.470/6.339 seconds in this run. The evaluation's owner session was revoked.

## Historical EC2 baseline

The EC2 application stack reached `CREATE_COMPLETE`. Bootstrap prepared the RDS schema, imported six documents/83 chunks into pgvector and initialized the owner account. Spring/Nginx readiness and the RAG initialization process succeeded.

Public HTTPS checks passed for owner authentication, reserved-email registration 403, 14,867-row candidate analytics with no model promotion, supported ML template inference, pgvector document retrieval and non-owner RAG 403. The serving model remains the validated model trained from 2,197 cleaned rows. The extra 54,815 imported records produced 14,867 clean rows for candidate evaluation; they did not replace that serving model or the 83-chunk RAG collection.

Public WebSocket checks passed with synthetic positions: two sessions of one temporary account exchanged position/stop messages, another temporary account received none, and temporary accounts were deleted. The smoke helper compares normalized timestamps by instant. This validates the relay route, not real GPS hardware or background mobile tracking.

RAG used `use_llm=false`: query embedding usage occurred, while generated LLM explanations were not requested. These AWS baseline checks do not establish a new cloud LLM-answer evaluation.

## Container, ECS and first cycle verification

- The local final runtime image contains code and dependencies, excluding models, raw data, RAG corpus/vectors, keys and account configuration. Eleven unit checks cover download checksums, bounded/safe ZIP extraction, image-code preservation, metadata-only pointers, no candidate promotion, exact-key aggregate refresh and proxy-header configuration.
- An actual local container ran as UID 10001 with all Linux capabilities dropped and a read-only root filesystem. Named runtime/web/tmp volumes were writable as required. Spring with synthetic H2 data, Nginx/static web and Nginx WebSocket relay/isolation/stop all passed.
- The final image is `sha256:1509d2c69a2fd9908c7c14e611fd08f191275e36ca8d77495cd4cd0e31d55e5a`. PCRE2 10.42-4ubuntu2.2, removal of venv pip/OS pip wheel, required ML/database/AWS imports and isolated container checks were verified. The final ECR basic OS scan completed with zero findings; this does not certify all application dependencies or future scan results.
- ECS cluster and ECR creation completed. The initial foundation's role-propagation failure was recovered by retaining and importing ECR/log resources into the completed v2 foundation. CloudWatch retention is 14 days.
- One 1-vCPU/3-GiB Fargate task is running with healthy API revision 2 and Nginx; service rollout completed. It reuses the existing RDS database. CloudFront is `Deployed`, the service stack is `UPDATE_COMPLETE`, and the new public-route checks above passed.
- Nginx's API and WS routes now set `X-Forwarded-Port: 443` and remove `Forwarded`. The prior image reproduced the public-origin 403 caused by ALB port 80; the final image passed same-origin POST/WS under that header input while keeping foreign-origin 403. Eleven runtime unit checks and the actual Docker proxy/WS regression passed.
- The separate cycle task uses the worker's `--once` behavior. First task `f60172775bd643f8bf0e8d6221328487` and run `20261104T111517Z-6ac82deb` succeeded: `onbid-api-v1`, event dates 2025-11-04 through 2026-11-03, 5,268 raw / 2,284 passenger / 2,187 clean / 3,081 excluded rows, 154 repeated groups and 13 API calls. S3 latest/marker identifiers match and use AES256 encryption; request reservations, SQS and DLQ counts are zero. The public API refresh matches this result, with `production_promoted=false`.
- The hourly worker rule is `ENABLED`, targets exact cycle revision 2 and has an `UPDATE_COMPLETE` stack. It polls once and exits without collecting when the queue is empty. The weekly enqueue rule was separately read back as `ENABLED`, with `cron(0 17 ? * SUN *)` (Monday 02:00 KST); the worker runs at minute 05 each hour. A first future scheduled run and long-term failure/retry behavior have not yet been observed.
- The 2,187-row cycle result does not overwrite the serving 2,197-row model or promote the separately preserved 14,867-row historical candidate. These counts describe different artifacts.
- Kubernetes rendering is validated; there is no deployed Kubernetes cluster.

Temporary-compute cleanup reached `UPDATE_COMPLETE` on the old application stack at 2026-11-04 11:42:22 UTC. The EC2 instance is terminated and the former CloudFront distribution/VPC origin were directly confirmed deleted. The same RDS endpoint remained available, encrypted and deletion-protected, with one-day backups unchanged. The single ECS task remained healthy throughout this final check.

Prior EC2 `foundation.json`/`application.json` lint and selected AWS Guard checks remain historical validation of those templates. They do not prove the new ECS templates or deployed service are healthy. Record new ECS template results and post-deployment checks separately.

## Explicit limits and blocked activation

RDS PostgreSQL 18.6 runs on `db.t4g.micro`, Single-AZ with one-day backups, as selected by the user. Keep the explicit `RDS_MULTI_AZ_SUPPORT` exception visible; this configuration has no automatic standby failover. Do not report an unconditional availability-control pass.

The ordinary API runtime uses the application DB credential and never receives the master secret or owner bootstrap password. Schema initialization is disabled. The existing application DB role still owns schema/tables, so DML-only database privileges have not been established.

GitHub OIDC provider `Get`/`List` calls are denied by organization SCP `p-5httx2mw`; automatic CD activation is blocked. Successful CI, ECR preparation and local Docker checks do not remove that restriction.

The estimated Fargate compute component is about US$47/month; RDS, ALB, storage, traffic, logs and external API usage are additional. The user's KRW 200,000 monthly target is not a spending cap. Validate actual costs after deployment and retain historical snapshot/key storage costs in that accounting.

The earlier SQS policy correction, DB creation dependency and account-confirmed CloudFront 120-second response timeout remain part of the EC2 baseline history. The Python worker deadline is 115 seconds. Container health, one successful cycle and one full public smoke do not establish sustained latency or long-term reliability; those require operational monitoring.

See [current execution checkpoint](DEPLOYMENT-STATUS.md) for pending steps and [runtime configuration](../containers/README.md) for container roles and secret boundaries.
