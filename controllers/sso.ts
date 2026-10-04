import type { FastifyRequest, FastifyReply } from "fastify";
import crypto from "node:crypto";
import { processSsoLogin } from "../services/SsoAuthService.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { completeVerifiedLogin } from "./auth.ts";
import { SsoAssertion } from "../models/SsoAssertion.ts";

export async function initiateSsoRedirect(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { provider } = req.query as { provider?: string };
    const targetProvider = provider || "azure_ad";
    const allowedProviders = ["azure_ad", "okta", "google_workspace", "saml2"];
    if (!allowedProviders.includes(targetProvider)) return reply.code(400).send(errorResponse("Unsupported SSO provider"));
    const ssoAuthorizationUrl = process.env.SSO_AUTHORIZATION_URL?.trim();
    if (!ssoAuthorizationUrl) return reply.code(503).send(errorResponse("SSO provider is not configured"));

    const redirect = new URL(ssoAuthorizationUrl);
    if (redirect.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && redirect.hostname === 'localhost')) return reply.code(503).send(errorResponse('SSO URL must use HTTPS'));
    redirect.searchParams.set("provider", targetProvider);
    const redirectUrl = redirect.toString();

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
    const callbackSecret = process.env.SSO_CALLBACK_SECRET?.trim();
    if (!callbackSecret) {
      return reply.code(503).send(errorResponse("SSO callback verification is not configured"));
    }
    const signature = req.headers["x-sso-signature"];
    const suppliedSignature = Array.isArray(signature) ? signature[0] : signature;
    const expectedSignature = crypto.createHmac("sha256", callbackSecret).update(JSON.stringify(req.body || {})).digest("hex");
    if (!suppliedSignature || suppliedSignature.length !== expectedSignature.length || !crypto.timingSafeEqual(Buffer.from(suppliedSignature), Buffer.from(expectedSignature))) {
      return reply.code(401).send(errorResponse("Invalid SSO callback assertion"));
    }
    const { email, name, provider, externalId } = req.body as {
      email: string;
      name: string;
      provider: "azure_ad" | "okta" | "google_workspace" | "saml2";
      externalId: string;
    };
    const { aud, iat, exp, nonce } = req.body as any;
    const audience = process.env.SSO_CALLBACK_AUDIENCE?.trim();
    if (!audience) return reply.code(503).send(errorResponse("SSO assertion audience is not configured"));
    const now = Math.floor(Date.now() / 1000);
    if (aud !== audience || !Number.isInteger(iat) || !Number.isInteger(exp) ||
      iat > now + 30 || exp <= now || exp <= iat || exp - iat > 300 ||
      typeof nonce !== "string" || nonce.length < 16 || nonce.length > 128 ||
      !["azure_ad", "okta", "google_workspace", "saml2"].includes(provider) ||
      typeof externalId !== "string" || !externalId || externalId.length > 256 ||
      typeof email !== 'string' || email.length > 254 || !email.includes('@') ||
      (name !== undefined && (typeof name !== 'string' || name.length > 255))) {
      return reply.code(401).send(errorResponse("Invalid or expired SSO assertion"));
    }
    try {
      await SsoAssertion.create({ _id: crypto.createHash("sha256").update(`${provider}:${nonce}`).digest("hex"),
        expiresAt: new Date(exp * 1000) });
    } catch (err: any) {
      if (err.code === 11000) return reply.code(401).send(errorResponse("SSO assertion already consumed"));
      throw err;
    }

    if (!email) {
      return reply.code(400).send(errorResponse("Email is required in SSO assertion payload"));
    }

    const authResult = await processSsoLogin({
      email,
      name: name || email.split("@")[0],
      provider: provider || "azure_ad",
      externalId: externalId || `EXT-${Date.now()}`,
    });

    return await completeVerifiedLogin(req, reply, authResult.userRecord);
  } catch (err) {
    console.error("handleSsoCallback error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
