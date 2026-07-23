# Fly.io deployment adapter

Support tier: **experimental until the shared deployment suite passes**.

Model Fly.io as an image/container rollout. Capture application, organization,
release/deployment identity, image digest, intended revision label, machine
health, canonical hostname mapping, and focused smoke result. Command success
without image and live-target evidence is partial, not verified.

Prefer provider-native release promotion or rollback of the existing verified
image over creating a duplicate release. Reconcile only hostnames already
attached to the same application; certificates, DNS, and domain ownership remain
separate capabilities.
