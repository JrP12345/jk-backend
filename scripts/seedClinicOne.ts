import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { Clinic } from "../models/Clinic.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Patient } from "../models/Patient.ts";
import { Consent } from "../models/Consent.ts";
import { Appointment } from "../models/Appointment.ts";
import { Encounter } from "../models/Encounter.ts";
import { ClinicalNote } from "../models/ClinicalNote.ts";
import { Prescription } from "../models/Prescription.ts";
import { DocumentUpload } from "../models/DocumentUpload.ts";
import { Medicine } from "../models/Medicine.ts";

async function seedClinicOne() {
  if (process.env.NODE_ENV === "production" && !process.argv.includes("--force-production-seed")) {
    console.error("FATAL: Seed scripts cannot run in production without --force-production-seed flag!");
    process.exit(1);
  }

  const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/ananta_health_os";
  console.log(`Connecting to MongoDB at ${mongoUri}...`);
  await mongoose.connect(mongoUri);

  try {
    console.log("Seeding Clinic #1: Apollo Clinic Indiranagar (Dr. Rajesh Benchmark)...");

    // 1. Create Organization
    let org = await Organization.findOne({ name: "Apollo Clinic Network" });
    if (!org) {
      org = await (Organization as any).create({
        name: "Apollo Clinic Network",
        contactEmail: "admin@apollo-clinic.internal",
      });
    }
    const orgId = org!._id;

    // 2. Create Clinic
    let clinic = await Clinic.findOne({ organizationId: orgId, name: "Apollo Clinic Indiranagar" });
    if (!clinic) {
      clinic = await Clinic.create({
        organizationId: orgId,
        name: "Apollo Clinic Indiranagar",
        address: "100 Feet Road, Indiranagar, Bangalore - 560038",
        phone: "+91-80-2525-9988",
        email: "indiranagar@apollo-clinic.internal",
      });
    }

    // 3. Create Doctor (Dr. Rajesh Sharma)
    const doctorEmail = "dr.rajesh@apollo-clinic.internal";
    let doctorUser = await User.findOne({ email: doctorEmail });
    if (!doctorUser) {
      const hashedPassword = await bcrypt.hash("DoctorPass123!", 10);
      doctorUser = await (User as any).create({
        name: "Dr. Rajesh Sharma",
        email: doctorEmail,
        password: hashedPassword,
        role: "doctor",
        organizationId: orgId,
        phone: "+91-98800-11223",
      });
    }
    const doctorUserId = doctorUser!._id;

    // Org Member & Assignment
    await OrgMember.findOneAndUpdate(
      { userId: doctorUserId, organizationId: orgId },
      { userId: doctorUserId, organizationId: orgId, role: "doctor" },
      { upsert: true }
    );

    await DoctorAssignment.findOneAndUpdate(
      { doctorId: doctorUserId, clinicId: clinic._id },
      { doctorId: doctorUserId, clinicId: clinic._id, isPrimary: true },
      { upsert: true }
    );

    // 4. Create Medicines
    const medicinesData = [
      { name: "Metformin XR", genericName: "Metformin Hydrochloride", dosageForm: "Tablet", strength: "500mg", price: 45, stockQuantity: 150 },
      { name: "Telmisartan 40", genericName: "Telmisartan", dosageForm: "Tablet", strength: "40mg", price: 68, stockQuantity: 200 },
      { name: "Paracetamol 650", genericName: "Paracetamol", dosageForm: "Tablet", strength: "650mg", price: 20, stockQuantity: 500 },
      { name: "Cetirizine 10", genericName: "Cetirizine Dihydrochloride", dosageForm: "Tablet", strength: "10mg", price: 30, stockQuantity: 300 },
    ];

    for (const med of medicinesData) {
      await Medicine.findOneAndUpdate(
        { organizationId: orgId, clinicId: clinic._id, name: med.name },
        { ...med, organizationId: orgId, clinicId: clinic._id },
        { upsert: true }
      );
    }

    // 5. Create Sample Patient 1 (Ananya Patel)
    const patientEmail = "ananya.patel@example.com";
    let patientUser = await User.findOne({ email: patientEmail });
    if (!patientUser) {
      const hashedPassword = await bcrypt.hash("PatientPass123!", 10);
      patientUser = await (User as any).create({
        name: "Ananya Patel",
        email: patientEmail,
        password: hashedPassword,
        role: "patient",
        organizationId: orgId,
        phone: "+91-99450-88776",
      });
    }

    let patientProfile = await Patient.findOne({ userId: patientUser!._id });
    if (!patientProfile) {
      patientProfile = await Patient.create({
        userId: patientUser!._id,
        organizationId: orgId,
        personalVaultId: `pvt_${patientUser!._id.toString()}`,
        dob: new Date("1990-05-14"),
        gender: "female",
        bloodGroup: "O+",
        address: "Koramangala 4th Block, Bangalore",
        allergies: ["Penicillin"],
        conditions: ["Type 2 Diabetes Mellitus", "Hypertension"],
        emergencyContacts: [{ name: "Siddharth Patel", relationship: "Spouse", phone: "+91-99450-88777" }],
      });
    }

    // 6. Create Active Consent Grant for Clinic
    await Consent.findOneAndUpdate(
      { patientId: patientProfile._id, "grantee.organizationId": orgId },
      {
        patientId: patientProfile._id,
        grantee: { organizationId: orgId, doctorId: doctorUserId },
        status: "active",
        scope: ["READ_TIMELINE", "WRITE_ENCOUNTER", "VIEW_LABS", "VIEW_IMAGING"],
        period: { start: new Date(), end: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) },
        provision: { type: "permit", purpose: ["TREATMENT", "BILLING"] },
        audit: { grantedAt: new Date(), grantedVia: "CLINIC_ONE_SEEDING" },
      },
      { upsert: true }
    );

    // 7. Create Appointment & Active Encounter
    let appt = await Appointment.findOne({ clinicId: clinic._id, patientId: patientProfile._id });
    if (!appt) {
      appt = await (Appointment as any).create({
        organizationId: orgId,
        clinicId: clinic._id,
        doctorId: doctorUserId,
        patientId: patientProfile._id,
        appointmentTime: new Date(),
        appointmentType: "walk-in",
        status: "checked-in",
        queueNumber: 1,
        notes: "Routine diabetes & BP check",
      });
    }

    let encounter = await Encounter.findOne({ appointmentId: appt!._id });
    if (!encounter) {
      encounter = await Encounter.create({
        organizationId: orgId,
        clinicId: clinic._id,
        appointmentId: appt!._id,
        patientId: patientProfile._id,
        doctorId: doctorUserId,
        encounterType: "opd",
        status: "in_progress",
        startedAt: new Date(),
      });
    }

    // 8. Create Sample Clinical Note
    await ClinicalNote.findOneAndUpdate(
      { encounterId: encounter._id },
      {
        organizationId: orgId,
        clinicId: clinic._id,
        encounterId: encounter._id,
        patientId: patientProfile._id,
        doctorId: doctorUserId,
        version: 1,
        isLatest: true,
        isFinal: false,
        subjective: {
          chiefComplaint: "Routine diabetes & hypertension follow-up",
          historyOfPresentIllness: "Patient reports mild afternoon fatigue. Compliant with Metformin XR.",
        },
        vitals: {
          bpSystolic: 130,
          bpDiastolic: 84,
          pulseRate: 74,
          spO2: 98,
          temperatureF: 98.4,
        },
        assessment: {
          diagnoses: [{ code: "E11.9", description: "Type 2 Diabetes Mellitus", type: "primary" }],
        },
        plan: {
          treatmentPlan: "Continue current Metformin XR regimen. Re-check HbA1c in 30 days.",
        },
      },
      { upsert: true }
    );

    console.log("✅ Clinic #1 Seeding Complete!");
    console.log("-------------------------------------------------------");
    console.log(`Clinic Name  : Apollo Clinic Indiranagar`);
    console.log(`Doctor Login : dr.rajesh@apollo-clinic.internal (DoctorPass123!)`);
    console.log(`Patient Name : Ananya Patel (Queue #1 Checked-in)`);
    console.log("-------------------------------------------------------");
  } catch (err) {
    console.error("❌ Error seeding Clinic #1:", err);
  } finally {
    await mongoose.disconnect();
  }
}

seedClinicOne();
