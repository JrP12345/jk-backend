import type { FHIRBundle, FHIRResource } from "../types.ts";

export class BundleAssembler {
  /**
   * Combines an array of FHIR resources into a standardized FHIR R4 Bundle document.
   */
  public static createDocumentBundle(resources: FHIRResource[]): FHIRBundle {
    const validResources = resources.filter((r) => r && r.resourceType && r.id);

    const entries = validResources.map((res) => ({
      fullUrl: `urn:uuid:${res.id}`,
      resource: res,
    }));

    return {
      resourceType: "Bundle",
      id: `bundle-${Date.now()}`,
      type: "document",
      timestamp: new Date().toISOString(),
      total: entries.length,
      entry: entries,
    };
  }
}
