import { Location } from "../../models/Location.ts";
import { User } from "../../models/User.ts";
import { publicSlug } from "../../utilities/publicLinks.ts";

/** Tests obtain the same readable public links returned by the directory API. */
export async function providerFixtureSlug(kind: "location" | "doctor", id: unknown) {
  const record = kind === "location"
    ? await Location.findById(String(id)).select("name")
    : await User.findById(String(id)).select("name");
  if (!record) throw new Error("Provider fixture requires an existing record");
  return publicSlug(kind, String(id), record.name);
}
