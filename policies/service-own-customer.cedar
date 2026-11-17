// Service Gateway, low-risk tools: own customer only.
permit(
  principal is AgentCore::OAuthUser,
  action in [
    AgentCore::Action::"service___request_statement",
    AgentCore::Action::"service___order_chequebook"
  ],
  resource == AgentCore::Gateway::"__GATEWAY_ARN__"
) when {
  principal.hasTag("username") &&
  context.input.customer_id == principal.getTag("username")
};
