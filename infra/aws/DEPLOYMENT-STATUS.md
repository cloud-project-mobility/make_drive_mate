# AWS execution status — November 4, 2026

This is an **ECS transition checkpoint, before creation of the ECS application service**. The existing EC2 application stack is `CREATE_COMPLETE` and its public HTTPS baseline has passed. The requested final deployment is ECS Fargate. **No final ECS service URL or successful ECS rollout is recorded yet.**

## Completed and verified

| Area                  | Evidence at this checkpoint                                                                                                                                                                                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing EC2 baseline | Bootstrap completed; Spring and Nginx are active. Keep this temporary baseline until the ECS replacement is verified.                                                                                                                                                                          |
| RDS                   | PostgreSQL 18.6, `db.t4g.micro`, Single-AZ, one-day backups. Application schema and owner account initialized.                                                                                                                                                                                 |
| Document RAG          | Six documents and 83 chunks loaded into RDS pgvector. Owner HTTPS retrieval returned six sources; another account received 403.                                                                                                                                                                |
| Authentication        | Owner login passed; public registration of the reserved owner email returned 403.                                                                                                                                                                                                              |
| ML and analytics      | Public HTTPS supported-vehicle template inference passed. Analytics reported 14,867 clean candidate rows with `production_promoted=false`; the serving model remains the validated 2,197-row model.                                                                                            |
| WebSocket             | Public WSS ready, synthetic same-account position relay, cross-account isolation and stop passed. Timestamp values were compared as instants rather than raw formatting strings. No real device location was used. Temporary test accounts were deleted and the test owner session logged out. |
| ECS foundation        | Cluster and ECR exist. The first foundation attempt hit IAM role propagation failure; retained ECR/log resources were imported into the completed v2 foundation. Log retention is 14 days.                                                                                                     |
| Runtime image         | Code-only image built locally. Ten artifact/runtime unit tests and an isolated container check passed: UID 10001, read-only root, writable ephemeral volumes, Spring/Nginx health and synthetic WebSocket relay/isolation/stop.                                                                |

The metadata-only RAG serving pointer contains collection identifiers, hashes, counts and storage metadata. It does not contain document excerpts, chunks, embeddings or credentials. The API reads document content from RDS; it does not follow the pointer's local-index path into another S3 object.

## Prepared target and remaining work

The target is **CloudFront → ALB → one ECS Fargate task with separate Nginx and Spring/Python containers**, sized at 1 vCPU and 3 GiB. The API replica count stays at one because live-location relay state is in memory. A separate on-demand/weekly cycle task consumes SQS once and exits; it is not a continuously running worker service.

- ECR upload and the ECS application service still require final completion evidence. Cluster creation and local image tests are not application deployment completion.
- After ECS starts, repeat HTTPS authentication, ML, candidate analytics, owner/non-owner RAG and WSS synthetic relay checks through the new public route.
- Verify CloudWatch delivery, ALB/task health, release/pointer checksums and cleanup before removing the temporary EC2 host.
- A full SQS → cycle task → S3 → API aggregate refresh and the weekly schedule remain unverified. The schedule must stay disabled until validated. A completed cycle must not promote the service model.
- Kubernetes manifests have been rendered only. No Kubernetes cluster or Kubernetes deployment exists.

## CI/CD blocker

ECS CD code builds from verified main CI outputs, publishes an immutable ECR digest and replaces the API/Nginx task revision with rollback checks. It is **not active**. GitHub OIDC provider `Get` and `List` operations are denied by organization SCP **`p-5httx2mw`**. An organization-policy change or another explicitly reviewed authentication route is needed before OIDC/CD can be enabled. Local image builds and manual deployment preparation do not resolve this blocker.

## Privileges, availability and cost

The API task receives selected application secret fields and uses `drivemate_app`; it does not receive the RDS master secret, initial owner password or bootstrap token, and runtime schema initialization is disabled. The role created by the existing bootstrap still owns application schema/tables. This is **not a claim that the database role has already been reduced to DML-only permissions**.

Single-AZ with one-day backups is the user's selected configuration. It has no database standby failover. The approximate prepared Fargate compute estimate is **US$47/month**, before RDS, ALB, storage, traffic, logs and external API usage. KRW 200,000/month is a planning target, not an enforced or verified spending ceiling.

Earlier failed deployment resources were cleaned up with the final encrypted snapshot `drivemate-poc-20261104-precleanup-01` preserved. That historical cleanup does not mean the newly created EC2/RDS resources are absent. Keep the snapshot's encryption key while retaining the backup, and include retained storage/secrets/keys in cost review.

Update this checkpoint only after recording the actual ECS task revision, public route and post-deployment results. See [validation scope](VALIDATION.md) and [container runtime contract](../containers/README.md).
