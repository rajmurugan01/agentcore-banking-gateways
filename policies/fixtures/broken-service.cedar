// GATE FIXTURE ONLY. Same bug on the Service Gateway, and it also (wrongly) permits change_address with no
// step-up check and kyc_update. Never attach to a real Gateway.
permit(
  principal is AgentCore::OAuthUser,
  action in [
    AgentCore::Action::"service___request_statement",
    AgentCore::Action::"service___change_address",
    AgentCore::Action::"service___order_chequebook",
    AgentCore::Action::"service___kyc_update"
  ],
  resource == AgentCore::Gateway::"__GATEWAY_ARN__"
) when {
  context.input has customer_id
};
