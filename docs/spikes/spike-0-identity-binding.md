# Spike 0: can a Gateway Cedar policy bind both the user and the calling agent?
Date: 2026-11-17. Method: AWS AgentCore docs only (no live test yet). Status: docs answer is "not documented".

## Question
S4 needs "no agent may call kyc_update". S3 and S5 need the asking user's identity. Can one Cedar
decision see both the end user and the specific specialist agent that is calling?

## What the docs confirm
- Principal on an OAuth Gateway is `AgentCore::OAuthUser`, built from the JWT `sub`. Other JWT claims are
  tags on it (`principal.getTag(...)`). Tool arguments are in `context.input`.
  (policy-core-concepts, policy-conditions)
- `tools/list` is a policy-governed "meta action": a caller only sees tools it would be permitted to call.
  (use-gateway-with-policy)
- The inbound authorizer supports `allowedClients`, `allowedAudience`, `allowedScopes` and `customClaims`.
  (gateway-inbound-auth)
- Interceptors can read headers only if `passRequestHeaders` is true. A REQUEST interceptor can return a
  transformed request; the MCP example shows a body only. (gateway-interceptors)

## What the docs do NOT confirm
- Any Cedar attribute for the calling agent or workload identity. The workload "caller chain" appears only
  in the temporal-policy section and is not shown as principal or context.
- Whether anything an interceptor adds is visible to Cedar, and the evaluation order of interceptor vs policy.
- Cognito pre-token-generation V2 adding custom claims to ACCESS tokens, and the tier it needs (not read).

## Decision for the build
1. Policy decides on the USER (sub + claims) and tool arguments only. I do not claim agent-identity binding.
2. Per-specialist Gateways: an Accounts Gateway with only account tools and a Service Gateway with only
   service tools. An agent cannot reach a tool that is not on its Gateway. This is topology, not policy, and
   the README must say so.
3. S4 is a `forbid` for every principal on `kyc_update`: the tool is human-only, reached by no agent path.
4. Untested and listed as a limit: binding the agent identity in Cedar. Optional later spike: live test of
   an interceptor-added header and of a Cognito V2 access-token claim.
