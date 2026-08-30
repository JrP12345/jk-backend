import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/ananta_health";

export async function migrateTenantScoping() {
  console.log("[Migration] Starting Organization Tenant Scoping Migration...");
  
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(MONGODB_URI);
    console.log("[Migration] Connected to MongoDB.");
  }

  const db = mongoose.connection.db;
  if (!db) {
    throw new Error("[Migration] Database connection unavailable");
  }

  // 1. Build Clinic ID -> Organization ID lookup map
  const clinicsCollection = db.collection("clinics");
  const clinics = await clinicsCollection.find({}).toArray();
  const clinicOrgMap = new Map<string, mongoose.Types.ObjectId>();

  for (const clinic of clinics) {
    if (clinic.organizationId) {
      clinicOrgMap.set(clinic._id.toString(), clinic.organizationId);
    }
  }
  console.log(`[Migration] Mapped ${clinicOrgMap.size} clinics to their parent organizations.`);

  // Default fallback organization (if any record has an unmapped clinicId)
  const orgsCollection = db.collection("organizations");
  const defaultOrg = await orgsCollection.findOne({});
  const defaultOrgId = defaultOrg?._id || new mongoose.Types.ObjectId();

  const targetCollections = [
    "appointments",
    "laborders",
    "prescriptions",
    "clinicalnotes",
    "encounters",
    "imagingstudies",
    "medicines",
    "invoices",
    "auditlogs",
    "patients",
  ];

  let totalUpdated = 0;

  for (const collectionName of targetCollections) {
    const col = db.collection(collectionName);
    const cursor = col.find({
      $or: [{ organizationId: { $exists: false } }, { organizationId: null }],
    });

    let updatedInCollection = 0;
    while (await cursor.hasNext()) {
      const doc = await cursor.next();
      if (!doc) break;

      let targetOrgId = defaultOrgId;
      if (doc.clinicId && clinicOrgMap.has(doc.clinicId.toString())) {
        targetOrgId = clinicOrgMap.get(doc.clinicId.toString())!;
      }

      await col.updateOne(
        { _id: doc._id },
        { $set: { organizationId: targetOrgId } }
      );
      updatedInCollection++;
    }

    console.log(`[Migration] Collection '${collectionName}': Backfilled ${updatedInCollection} records with organizationId.`);
    totalUpdated += updatedInCollection;
  }

  console.log(`[Migration] Completed tenant scoping migration. Total records updated: ${totalUpdated}`);
  return { totalUpdated, clinicsMapped: clinicOrgMap.size };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("migrateTenantScoping.ts")) {
  migrateTenantScoping()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[Migration Error]", err);
      process.exit(1);
    });
}
