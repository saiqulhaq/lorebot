# Deploy Guide

Production deploys happen from the `main` branch only.

## Steps

1. Merge your PR into `main` after two approvals.
2. CI builds and pushes the image automatically.
3. Trigger the deploy from the #deploys Slack channel with `/deploy production`.
4. Watch the dashboard at grafana.internal/deploys for 15 minutes after rollout.

## Rollback

Run `/deploy rollback production` in #deploys. This redeploys the previous
image tag. Database migrations are NOT rolled back automatically — escalate
to the on-call DBA if a migration needs reverting.

Deploy freeze: every Friday after 3 PM and during the December holiday window.
