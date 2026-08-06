import mongoose from "mongoose";

async function purgeDuplicatesAndOrphans() {
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/jk-healthcare";
  await mongoose.connect(uri);

  const orgs = await mongoose.connection.collection("organizations").find({}).toArray();
  const validOrgIds = orgs.map((o) => o._id.toString());

  const clinics = await mongoose.connection.collection("clinics").find({}).toArray();
  console.log(`Total clinics in DB before cleanup: ${clinics.length}`);

  const seenNames = new Map<string, any>();
  const toDelete: mongoose.Types.ObjectId[] = [];

  for (const c of clinics) {
    const orgIdStr = (c.organizationId || c.organization_id || "").toString();
    // 1. If organization doesn't exist, purge orphan
    if (!validOrgIds.includes(orgIdStr)) {
      console.log(`Deleting orphan clinic: ${c.name} (${c._id}) — Org ${orgIdStr} no longer exists`);
      toDelete.push(c._id);
      continue;
    }

    // 2. If duplicate name within same organization, keep newest / one with logo
    const key = `${orgIdStr}_${c.name.trim().toLowerCase()}`;
    if (seenNames.has(key)) {
      const existing = seenNames.get(key);
      if (!c.logo && existing.logo) {
        console.log(`Deleting duplicate older clinic: ${c.name} (${c._id})`);
        toDelete.push(c._id);
      } else {
        console.log(`Deleting duplicate older clinic: ${existing.name} (${existing._id})`);
        toDelete.push(existing._id);
        seenNames.set(key, c);
      }
    } else {
      seenNames.set(key, c);
    }
  }

  if (toDelete.length > 0) {
    const res = await mongoose.connection.collection("clinics").deleteMany({ _id: { $in: toDelete } });
    console.log(`Successfully purged ${res.deletedCount} duplicate/orphan clinic records.`);
  } else {
    console.log("No duplicate or orphan clinics found.");
  }

  const remaining = await mongoose.connection.collection("clinics").find({}).toArray();
  console.log(`Total clinics remaining in DB: ${remaining.length}`);
  remaining.forEach((r) => console.log(`- Remaining Clinic: ${r.name} (${r._id}) under Org: ${r.organizationId || r.organization_id}`));

  await mongoose.disconnect();
}

purgeDuplicatesAndOrphans().catch(console.error);
