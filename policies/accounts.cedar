// Accounts Gateway. A customer may read only their own accounts. The agent supplies customer_id as a tool
// argument; the policy checks it equals the username on the verified JWT, so an agent cannot read for someone else.
permit(
  principal is AgentCore::OAuthUser,
  action in [
    AgentCore::Action::"accounts___get_balance",
    AgentCore::Action::"accounts___list_transactions"
  ],
  resource == AgentCore::Gateway::"__GATEWAY_ARN__"
) when {
  principal.hasTag("username") &&
  context.input.customer_id == principal.getTag("username")
};
