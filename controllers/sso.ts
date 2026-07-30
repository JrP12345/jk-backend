import type { FastifyRequest, FastifyReply } from "fastify";
import { processSsoLogin } from "../services/SsoAuthService.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

export async function initiateSsoRedirect(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { provider } = req.query as { provider?: string };
    const targetProvider = provider || "azure_ad";

    const redirectUrl = `https://sso.healthos.ananta.org/auth/realms/enterprise/protocol/openid-connect/auth?client_id=ananta-erp&response_type=code&scope=openid%20profile%20email&provider=${targetProvider}`;

    return reply.code(200).send(
      successResponse({
        provider: targetProvider,
        redirectUrl,
      }, "Enterprise SSO Auth URL generated")
    );
  } catch (err) {
    console.error("initiateSsoRedirect error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function handleSsoCallback(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { email, name, provider, externalId } = req.body as {
      email: string;
      name: string;
      provider: "azure_ad" | "okta" | "google_workspace" | "saml2";
      externalId: string;
    };

    if (!email) {
      return reply.code(400).send(errorResponse("Email is required in SSO assertion payload"));
    }

    const authResult = await processSsoLogin({
      email,
      name: name || email.split("@")[0],
      provider: provider || "azure_ad",
      externalId: externalId || `EXT-${Date.now()}`,
    });

    return reply.code(200).send(successResponse(authResult, "Enterprise SSO authentication successful"));
  } catch (err) {
    console.error("handleSsoCallback error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
