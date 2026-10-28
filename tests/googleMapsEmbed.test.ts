import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../index.ts";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { fixtureAccessToken } from "./helpers/sessionFixture.ts";
import { publicSlug } from "../utilities/publicLinks.ts";
import { isGoogleMapsEmbedUrl } from "../utilities/googleMapsEmbed.ts";

const embed = "https://www.google.com/maps/embed?pb=!1m18!2m3!1d0!2d72.9342!3d20.5992";
let token: string, organizationId: string;
beforeAll(async () => {
  await app.ready();
  const root = await User.create({ name: "Map setup root", email: "maps-root@example.test", role: "root", isActive: true });
  token = await fixtureAccessToken({ id: root.id, email: root.email!, role: "root" });
  const organization = await Organization.create({ name: "Map setup organization", city: "Surat", plan: "professional", maxLocations: 5 });
  organizationId = organization.id;
});

describe("scoped saved Google Maps embeds", () => {
  it("allows only shared Google HTTPS map embeds, without fetching arbitrary URLs", () => {
    expect(isGoogleMapsEmbedUrl(embed)).toBe(true);
    for (const value of ["javascript:alert(1)", "http://www.google.com/maps/embed?pb=x", "https://www.google.com.evil.test/maps/embed?pb=x", "https://www.google.com/url?pb=x", "https://user@www.google.com/maps/embed?pb=x", "https://www.google.com/maps/embed?pb=x&url=https://evil.test", "https://maps.app.goo.gl/short", `<iframe src="${embed}"></iframe>`, "https://www.google.com/maps/embed?pb=x#bad", "https://www.google.com:8443/maps/embed?pb=x"]) expect(isGoogleMapsEmbedUrl(value)).toBe(false);
  });
  it("persists, publicly exposes, edits and clears the map for the selected branch", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const created = await app.inject({ method: "POST", url: `/api/onboarding/locations?organizationId=${organizationId}`, headers, payload: { name: "Map test branch", city: "Surat", googleMapsEmbedUrl: embed } });
    expect(created.statusCode, created.body).toBe(201);
    const location = created.json().data;
    expect((await Location.findById(location.id))?.googleMapsEmbedUrl).toBe(embed);
    const slug = await publicSlug("location", location.id, location.name);
    const profile = await app.inject({ method: "GET", url: `/api/public/locations/${slug}` });
    expect(profile.statusCode, profile.body).toBe(200);
    expect(profile.json().data.googleMapsEmbedUrl).toBe(embed);
    const changed = embed + "&hl=en";
    const updated = await app.inject({ method: "PUT", url: `/api/onboarding/locations/${location.id}?organizationId=${organizationId}`, headers, payload: { name: location.name, city: "Surat", googleMapsEmbedUrl: changed } });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().data.googleMapsEmbedUrl).toBe(changed);
    const cleared = await app.inject({ method: "PUT", url: `/api/onboarding/locations/${location.id}?organizationId=${organizationId}`, headers, payload: { name: location.name, city: "Surat", googleMapsEmbedUrl: "" } });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect((await Location.findById(location.id))?.googleMapsEmbedUrl).toBeNull();
  });
  it("rejects unsafe sources and leaves another organization's location untouched", async () => {
    const foreignOrganization = await Organization.create({ name: "Other map organization", city: "Pune" });
    const foreign = await Location.create({ organizationId: foreignOrganization.id, name: "Foreign branch", city: "Pune", googleMapsEmbedUrl: embed });
    const headers = { authorization: `Bearer ${token}` };
    const denied = await app.inject({ method: "PUT", url: `/api/onboarding/locations/${foreign.id}?organizationId=${organizationId}`, headers, payload: { name: foreign.name, city: "Pune", googleMapsEmbedUrl: "" } });
    expect(denied.statusCode).toBe(404);
    expect((await Location.findById(foreign.id))?.googleMapsEmbedUrl).toBe(embed);
    const unsafe = await app.inject({ method: "POST", url: `/api/onboarding/locations?organizationId=${organizationId}`, headers, payload: { name: "Unsafe", city: "Surat", googleMapsEmbedUrl: "https://evil.test/map" } });
    expect(unsafe.statusCode).toBe(400);
    expect(await Location.countDocuments({ organizationId, name: "Unsafe" })).toBe(0);
    const anonymous = await app.inject({ method: "PUT", url: `/api/onboarding/locations/${foreign.id}`, payload: { name: foreign.name, city: "Pune", googleMapsEmbedUrl: "" } });
    expect([401, 403]).toContain(anonymous.statusCode);
  });
});
