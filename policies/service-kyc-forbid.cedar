// Human-only tool. No agent path may call it, whoever is asking. Default-deny already covers this; the explicit
// forbid is here so the intent is on the page and so a future permit cannot quietly re-open it.
forbid(
  principal,
  action == AgentCore::Action::"service___kyc_update",
  resource == AgentCore::Gateway::"__GATEWAY_ARN__"
);
