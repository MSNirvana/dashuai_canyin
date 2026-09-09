# P0 Safety Foundations Design

## Scope

This first remediation batch protects tenant boundaries, request idempotency,
render-accounting atomicity, and subscription error contracts. It does not
enable real payment, COS, FFmpeg, TTS, or production deployment.

## Goals

1. A merchant may only attach its own dish and media assets from the same store.
2. An idempotency key belongs to one merchant, operation, resource, and request
   payload. A conflicting reuse must return HTTP 409 without replaying data.
3. A render task is executable only after its bean reservation is persisted.
4. Exactly one terminal render settlement may consume or release one reservation.
5. Subscription-required creation and render operations consistently return
   HTTP 403 with business code 2005.

## Data Model

### BusinessRequest

Persist a request record keyed by merchant, operation, and request ID. It
stores the target resource, canonical payload hash, lifecycle state, and an
optional result reference. The same payload may recover the original result;
a different payload is a conflict.

### BeanReservation

Persist the reservation independently from ledger remarks, keyed by a business
scope such as RENDER plus task ID. It records reserved, consumed, released, and
state. Consumption and release are rejected if they exceed the reservation's
remaining amount. Bean account, reservation, ledger, request, and task updates
share one transaction.

## Tenant Boundary

Creation creation checks that the dish belongs to the authenticated merchant
and selected store. Shot binding, creation reads, and render submission each
re-check the asset's merchant and store. A failed check creates no creation,
shot update, or render task.

## Render State Machine

Pending reservation is internal only and never worker-visible. The submit
transaction creates the task, creates the reservation, writes the freeze ledger,
and exposes the task as QUEUED or MANUAL_PENDING atomically. Terminal
transitions use an expected active state predicate:

- Active task to SUCCESS consumes its reservation and saves the result.
- Active task to settlement-pending retains a release failure for compensation
  instead of claiming that a refund succeeded.
- Settlement-pending to FAILED occurs only after release succeeds.

This batch does not add a distributed worker lease or external reconciliation;
those remain a later reliability batch.

## API Contracts

- Tenant mismatch returns a stable client error and no mutation.
- Same scoped idempotency key plus a mismatched payload returns HTTP 409.
- Subscription-required copy, storyboard, and render requests return HTTP 403,
  business code 2005.
- Existing demo worker behavior remains development-only; production validation
  continues to reject demo settings.

## Tests and Verification

Add focused tests for A/B merchant dish and asset isolation, idempotency scope
and conflicts, reservation isolation, render terminal races, and subscription
contracts. Run TypeScript checks, server and mini builds, and a local service
startup with no external payment, AI, COS, or TTS operations.

## Explicit Non-Goals

- No real WeChat Pay integration or production payment configuration.
- No COS object metadata verification or real upload.
- No FFmpeg worker rollout, TTS provider implementation, or generated media.
- No production deployment, upload, review, or external API credential change.
