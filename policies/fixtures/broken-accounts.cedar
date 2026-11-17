// GATE FIXTURE ONLY. The classic bug: it checks that a customer_id argument EXISTS but never that it matches the
// verified token's username, so any authenticated user can read anyone's accounts. (AgentCore itself rejects a
// bare permit-all as "Overly Permissive", so the realistic wrong policy is the one that gets through.)
permit(
  principal is AgentCore::OAuthUser,
  action in [
    AgentCore::Action::"accounts___get_balance",
    AgentCore::Action::"accounts___list_transactions"
  ],
  resource == AgentCore::Gateway::"__GATEWAY_ARN__"
) when {
  context.input has customer_id
};
