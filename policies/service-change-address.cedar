// Service Gateway, high-risk tool: own customer AND a step-up. The step-up here is a Cognito group
// ("stepped-up") standing in for a real MFA/step-up claim: a default Cognito access token carries no acr/amr.
// The groups claim reaches Cedar as a string like ["stepped-up"], so match the QUOTED element.
permit(
  principal is AgentCore::OAuthUser,
  action == AgentCore::Action::"service___change_address",
  resource == AgentCore::Gateway::"__GATEWAY_ARN__"
) when {
  principal.hasTag("username") &&
  context.input.customer_id == principal.getTag("username") &&
  principal.hasTag("cognito:groups") &&
  principal.getTag("cognito:groups") like "*\"stepped-up\"*"
};
