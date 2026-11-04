# Deployment validation

The November 4, 2026 deployment uses the account's existing Free plan, as selected by the user after AWS rejected the initial paid-plan database configuration.

- `cfn-lint` validates `foundation.json` and `application.json` without findings.
- Official AWS Guard checks pass for private/encrypted RDS, S3 encryption, blocked public S3 access, versioning, and TLS-only S3 requests.
- `RDS_MULTI_AZ_SUPPORT` reports a known, explicit exception: the current account plan permits the selected `db.t4g.micro` Single-AZ configuration with one-day backups. This deployment does **not** provide automatic database standby failover. Moving to Multi-AZ and longer retention requires a paid account plan and a separately reviewed cost change.
- The application host is the API-confirmed Free-tier-eligible `c7i-flex.large` (2 vCPU, 4 GiB); this eligibility does not make all infrastructure or external model usage free.
- Shell syntax, all three embedded Python blocks, and the CloudWatch log-only configuration validate locally. Actual service readiness and log delivery require post-deployment verification.

Complete Guard results are retained in the gitignored deployment output directory. Keep the failed Multi-AZ check visible; do not remove that rule to report an unconditional pass.

The service rejected the initial shared SQS policy because each SQS statement must contain exactly one resource. The corrected template creates separate policies for the refresh and failed-job queues. Database creation now depends on both policies succeeding. CloudFront's account response-time quota was verified as 120 seconds; the template uses 120 seconds and AWS workers use a 115-second deadline.
