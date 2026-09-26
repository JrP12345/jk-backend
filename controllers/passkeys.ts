import type { FastifyRequest, FastifyReply } from "fastify";
import crypto from "node:crypto";
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
  type RegistrationResponseJSON, type AuthenticationResponseJSON, type AuthenticatorTransport,
} from "@simplewebauthn/server";
import { Passkey } from "../models/Passkey.ts";
import { PasskeyChallenge } from "../models/PasskeyChallenge.ts";
import { User } from "../models/User.ts";
import { getFrontendBaseUrl } from "../utilities/config.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { completeVerifiedLogin } from "./auth.ts";

const cookieName = "ananta_passkey_challenge";
const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
function relyingParty() {
  const origin = new URL(process.env.WEBAUTHN_ORIGIN || getFrontendBaseUrl());
  if (origin.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(origin.hostname)) {
    throw new Error("Passkeys require an HTTPS application URL");
  }
  return { origin: origin.origin, rpID: process.env.WEBAUTHN_RP_ID || origin.hostname };
}
async function storeChallenge(reply: FastifyReply, challenge: string, kind: string, req?: FastifyRequest) {
  const token = crypto.randomBytes(32).toString("base64url");
  await PasskeyChallenge.create({ tokenHash: hash(token), challenge, kind,
    userId: req?.user?.id, sessionId: req?.user?.sessionId,
    expiresAt: new Date(Date.now() + 5 * 60_000) });
  reply.setCookie(cookieName, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 300 });
}
async function consumeChallenge(req: FastifyRequest, reply: FastifyReply, kind: string) {
  const token = req.cookies?.[cookieName];
  reply.clearCookie(cookieName, { path: "/" });
  if (!token) throw new Error("Passkey request expired. Please try again.");
  const challenge = await PasskeyChallenge.findOneAndDelete({ tokenHash: hash(token), kind, expiresAt: { $gt: new Date() },
    ...(kind === "registration" ? { userId: req.user?.id, sessionId: req.user?.sessionId } : {}) });
  if (!challenge) throw new Error("Passkey request expired or already used");
  return challenge.challenge as string;
}
function canManage(req: FastifyRequest) {
  return req.user && req.user.role !== "guest" && !req.user.impersonatedBy;
}

export async function listPasskeys(req: FastifyRequest, reply: FastifyReply) {
  if (!canManage(req)) return reply.code(403).send(errorResponse("Sign in to your own account to manage passkeys"));
  const keys = await Passkey.find({ userId: req.user!.id }).select("name createdAt lastUsedAt backedUp").lean();
  return reply.send(successResponse(keys.map((key: any) => ({ ...key, id: key._id.toString() }))));
}
export async function registrationOptions(req: FastifyRequest, reply: FastifyReply) {
  if (!canManage(req)) return reply.code(403).send(errorResponse("Sign in to your own account to add a passkey"));
  try {
    const user = await User.findOne({ _id: req.user!.id, isActive: true });
    if (!user) return reply.code(403).send(errorResponse("Account is unavailable"));
    const keys = await Passkey.find({ userId: user._id }).lean();
    if (keys.length >= 10) return reply.code(400).send(errorResponse("Remove an existing passkey before adding another"));
    const { rpID } = relyingParty();
    const options = await generateRegistrationOptions({ rpName: "ANANTA Healthcare", rpID,
      userID: new TextEncoder().encode(user.id), userName: user.email || user.phone || user.id, userDisplayName: user.name,
      attestationType: "none", excludeCredentials: keys.map((key: any) => ({ id: key.credentialId, transports: key.transports })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" } });
    await storeChallenge(reply, options.challenge, "registration", req);
    return reply.send(successResponse(options));
  } catch { return reply.code(400).send(errorResponse("Could not start passkey registration. Check the application URL configuration.")); }
}
export async function registrationVerify(req: FastifyRequest, reply: FastifyReply) {
  if (!canManage(req)) return reply.code(403).send(errorResponse("Sign in to your own account to add a passkey"));
  try {
    const { response, name } = req.body as { response: RegistrationResponseJSON; name?: string };
    const challenge = await consumeChallenge(req, reply, "registration");
    const { origin, rpID } = relyingParty();
    const verification = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
    if (!verification.verified) throw new Error("Verification failed");
    const { credential, credentialBackedUp } = verification.registrationInfo;
    await Passkey.create({ userId: req.user!.id, credentialId: credential.id, publicKey: Buffer.from(credential.publicKey),
      counter: credential.counter, transports: credential.transports || [], backedUp: credentialBackedUp,
      name: typeof name === "string" ? name.trim().slice(0, 80) || "My passkey" : "My passkey" });
    return reply.send(successResponse(null, "Passkey added"));
  } catch { return reply.code(400).send(errorResponse("Passkey registration failed. Please try again.")); }
}
export async function authenticationOptions(_req: FastifyRequest, reply: FastifyReply) {
  try {
    const { rpID } = relyingParty();
    const options = await generateAuthenticationOptions({ rpID, userVerification: "required" });
    await storeChallenge(reply, options.challenge, "authentication");
    return reply.send(successResponse(options));
  } catch { return reply.code(400).send(errorResponse("Passkeys are unavailable. Check the application URL configuration.")); }
}
export async function authenticationVerify(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { response } = req.body as { response: AuthenticationResponseJSON };
    const challenge = await consumeChallenge(req, reply, "authentication");
    const key = await Passkey.findOne({ credentialId: response?.id });
    if (!key) throw new Error("Unknown passkey");
    if (response.response.userHandle && response.response.userHandle !== Buffer.from(key.userId.toString()).toString("base64url")) throw new Error("Passkey account mismatch");
    const { origin, rpID } = relyingParty();
    const verification = await verifyAuthenticationResponse({ response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID,
      requireUserVerification: true, credential: { id: key.credentialId, publicKey: new Uint8Array(key.publicKey), counter: key.counter, transports: key.transports as AuthenticatorTransport[] } });
    if (!verification.verified) throw new Error("Verification failed");
    const updated = await Passkey.updateOne({ _id: key._id, counter: key.counter }, { $set: { counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() } });
    if (!updated.modifiedCount) throw new Error("Passkey has already been used");
    const user = await User.findOne({ _id: key.userId, isActive: true });
    if (!user) throw new Error("Account is unavailable");
    return await completeVerifiedLogin(req, reply, user);
  } catch { return reply.code(401).send(errorResponse("Passkey sign-in failed. Please try again or use your usual sign-in method.")); }
}
export async function deletePasskey(req: FastifyRequest, reply: FastifyReply) {
  if (!canManage(req)) return reply.code(403).send(errorResponse("Sign in to your own account to manage passkeys"));
  const { id } = req.params as { id: string };
  if (!/^[a-f\d]{24}$/i.test(id)) return reply.code(400).send(errorResponse("Invalid passkey ID"));
  const result = await Passkey.deleteOne({ _id: id, userId: req.user!.id });
  if (!result.deletedCount) return reply.code(404).send(errorResponse("Passkey not found"));
  return reply.send(successResponse(null, "Passkey removed"));
}
