// GATE FIXTURE ONLY. Deliberately wrong: permits every action for every user on this Gateway. The gate test
// deploys it and asserts the scenario harness reports S2-S5 as FAILED. Never attach to a real Gateway.
permit(
  principal is AgentCore::OAuthUser,
  action,
  resource == AgentCore::Gateway::"__GATEWAY_ARN__"
);
