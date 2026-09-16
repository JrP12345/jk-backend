import mongoose from "mongoose";
import bcrypt from "bcryptjs";

// Import Models
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Clinic } from "../models/Clinic.ts";
import { Department } from "../models/Department.ts";
import { Doctor } from "../models/Doctor.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Receptionist } from "../models/Receptionist.ts";
import { Patient } from "../models/Patient.ts";
import { Encounter } from "../models/Encounter.ts";
import { Appointment } from "../models/Appointment.ts";
import { ClinicalNote } from "../models/ClinicalNote.ts";
import { Prescription } from "../models/Prescription.ts";
import { Medicine } from "../models/Medicine.ts";
import { LabTest } from "../models/LabTest.ts";
import { LabOrder } from "../models/LabOrder.ts";
import { Observation } from "../models/Observation.ts";
import { ObservationScore } from "../models/ObservationScore.ts";
import { ObservationAlert } from "../models/ObservationAlert.ts";
import { CDSEvaluation } from "../models/CDSEvaluation.ts";
import { Invoice } from "../models/Invoice.ts";
import { TaskModel } from "../models/Task.ts";
import { Notification } from "../models/Notification.ts";
import { NotificationDelivery } from "../models/NotificationDelivery.ts";
import { NotificationPreference } from "../models/NotificationPreference.ts";
import { NotificationTemplate } from "../models/NotificationTemplate.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Counter } from "../models/Counter.ts";
import { Role } from "../models/Role.ts";
import { Permission } from "../models/Permission.ts";
import { PendingTwoFactorSetup } from "../models/PendingTwoFactorSetup.ts";
import { OnboardingDraft } from "../models/OnboardingDraft.ts";
import { RefreshToken } from "../models/RefreshToken.ts";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/ananta_health";

async function runSeed() {
  if (process.env.NODE_ENV === "production") {
    console.error("FATAL: Destructive database seed scripts cannot be executed in production!");
    process.exit(1);
  }

  console.log("=======================================================================");
  console.log("🚀 [ANANTA HEALTHCARE SYSTEM] COMPLETE DATABASE PURGE & FRESH RESEED");
  console.log("=======================================================================");

  try {
    await mongoose.connect(MONGODB_URI);
    console.log("✓ Connected to MongoDB Atlas cluster.");

    // -------------------------------------------------------------------------
    // 1. WIPE ALL EXISTING COLLECTIONS
    // -------------------------------------------------------------------------
    console.log("\n🧹 Purging all database collections...");
    await Promise.all([
      User.deleteMany({}),
      Organization.deleteMany({}),
      OrgMember.deleteMany({}),
      Clinic.deleteMany({}),
      Department.deleteMany({}),
      Doctor.deleteMany({}),
      DoctorAssignment.deleteMany({}),
      Receptionist.deleteMany({}),
      Patient.deleteMany({}),
      Encounter.deleteMany({}),
      Appointment.deleteMany({}),
      ClinicalNote.deleteMany({}),
      Prescription.deleteMany({}),
      Medicine.deleteMany({}),
      LabTest.deleteMany({}),
      LabOrder.deleteMany({}),
      Observation.deleteMany({}),
      ObservationScore.deleteMany({}),
      ObservationAlert.deleteMany({}),
      CDSEvaluation.deleteMany({}),
      Invoice.deleteMany({}),
      TaskModel.deleteMany({}),
      Notification.deleteMany({}),
      NotificationDelivery.deleteMany({}),
      NotificationPreference.deleteMany({}),
      NotificationTemplate.deleteMany({}),
      AuditLog.deleteMany({}),
      Counter.deleteMany({}),
      Role.deleteMany({}),
      Permission.deleteMany({}),
      PendingTwoFactorSetup.deleteMany({}),
      OnboardingDraft.deleteMany({}),
      RefreshToken.deleteMany({}),
    ]);
    console.log("✓ All collections purged successfully.");

    // -------------------------------------------------------------------------
    // 2. CREATE ORGANIZATIONS & CLINICS
    // -------------------------------------------------------------------------
    console.log("\n🏢 Seeding Organization & Clinic architecture...");
    const org = await Organization.create({
      name: "ANANTA Healthcare & Research Institute",
      city: "San Francisco",
      address: "100 Medical Center Drive, Suite 500",
      phone: "+1 415 555 0199",
      email: "contact@ananta.health",
      onboardingStatus: "COMPLETED",
      isOnboarded: true,
      isActive: true,
    });

    const clinic = await Clinic.create({
      organizationId: org._id,
      name: "ANANTA Central Hospital & Emergency Pavilion",
      city: "San Francisco",
      address: "100 Medical Center Drive, Main Pavilion",
      phone: "+1 415 555 0100",
      email: "central@ananta.health",
    });

    // -------------------------------------------------------------------------
    // 3. CREATE SYSTEM USERS & ROLES
    // -------------------------------------------------------------------------
    console.log("\n👥 Seeding User Directory & Credentials...");
    const defaultPassword = await bcrypt.hash("Password123!", 10);

    // Root Admin
    const rootAdmin = await User.create({
      name: "Jay (Root Super Admin)",
      email: "21amtics177@gmail.com",
      password: defaultPassword,
      phone: "+1 415 555 9001",
      role: "root",
      // 2FA is provisioned with `npm run setup:root-2fa`; never create an
      // enabled root account without a corresponding secret.
      twoFactorEnabled: false,
      isActive: true,
    });

    // Hospital Admin
    const hospitalAdmin = await User.create({
      name: "Arthur Pendelton (Hospital Director)",
      email: "admin@ananta.health",
      password: defaultPassword,
      phone: "+1 415 555 9002",
      role: "admin",
      twoFactorEnabled: false,
      isActive: true,
    });

    // Doctors
    const drSarahUser = await User.create({
      name: "Dr. Sarah Jenkins, MD",
      email: "dr.sarah@ananta.health",
      password: defaultPassword,
      phone: "+1 415 555 9101",
      role: "doctor",
      isActive: true,
    });

    const drMarcusUser = await User.create({
      name: "Dr. Marcus Vance, MD",
      email: "dr.marcus@ananta.health",
      password: defaultPassword,
      phone: "+1 415 555 9102",
      role: "doctor",
      isActive: true,
    });

    const drPriyaUser = await User.create({
      name: "Dr. Priya Sharma, MD",
      email: "dr.priya@ananta.health",
      password: defaultPassword,
      phone: "+1 415 555 9103",
      role: "doctor",
      isActive: true,
    });

    const drChenUser = await User.create({
      name: "Dr. David Chen, MD",
      email: "dr.chen@ananta.health",
      password: defaultPassword,
      phone: "+1 415 555 9104",
      role: "doctor",
      isActive: true,
    });

    // Staff Users
    const receptionLisaUser = await User.create({
      name: "Lisa Ray (Morning Receptionist)",
      email: "reception.lisa@ananta.health",
      password: defaultPassword,
      phone: "+1 415 555 9201",
      role: "receptionist",
      isActive: true,
    });

    const nurseEmilyUser = await User.create({
      name: "Emily Watson, RN (ICU Nurse Lead)",
      email: "nurse.emily@ananta.health",
      password: defaultPassword,
      phone: "+1 415 555 9301",
      role: "nurse",
      isActive: true,
    });

    const labRobertUser = await User.create({
      name: "Robert Taylor (Lead Lab Technologist)",
      email: "lab.robert@ananta.health",
      password: defaultPassword,
      phone: "+1 415 555 9401",
      role: "lab_tech",
      isActive: true,
    });

    const pharmHannahUser = await User.create({
      name: "Hannah Abbott, PharmD (Chief Pharmacist)",
      email: "pharm.hannah@ananta.health",
      password: defaultPassword,
      phone: "+1 415 555 9501",
      role: "pharmacist",
      isActive: true,
    });

    // Patient Users
    const johnUser = await User.create({
      name: "John Doe",
      email: "john.doe@gmail.com",
      password: defaultPassword,
      phone: "+1 415 555 0001",
      role: "patient",
      isActive: true,
    });

    const mariaUser = await User.create({
      name: "Maria Garcia",
      email: "maria.garcia@gmail.com",
      password: defaultPassword,
      phone: "+1 415 555 0002",
      role: "patient",
      isActive: true,
    });

    const robertSmithUser = await User.create({
      name: "Robert Smith",
      email: "robert.smith@gmail.com",
      password: defaultPassword,
      phone: "+1 415 555 0003",
      role: "patient",
      isActive: true,
    });

    const emilyDavisUser = await User.create({
      name: "Emily Davis",
      email: "emily.davis@gmail.com",
      password: defaultPassword,
      phone: "+1 415 555 0004",
      role: "patient",
      isActive: true,
    });

    const jamesWilsonUser = await User.create({
      name: "James Wilson",
      email: "james.wilson@gmail.com",
      password: defaultPassword,
      phone: "+1 415 555 0005",
      role: "patient",
      isActive: true,
    });

    // Org Member associations
    const staffList = [
      { u: rootAdmin, r: "admin" },
      { u: hospitalAdmin, r: "admin" },
      { u: drSarahUser, r: "doctor" },
      { u: drMarcusUser, r: "doctor" },
      { u: drPriyaUser, r: "doctor" },
      { u: drChenUser, r: "doctor" },
      { u: receptionLisaUser, r: "receptionist" },
      { u: nurseEmilyUser, r: "nurse" },
      { u: labRobertUser, r: "lab_tech" },
      { u: pharmHannahUser, r: "pharmacist" },
    ];

    for (const item of staffList) {
      await OrgMember.create({
        userId: item.u._id,
        organizationId: org._id,
        role: item.r,
      });
    }

    // -------------------------------------------------------------------------
    // 4. DEPARTMENTS & DOCTOR PROFILES & ASSIGNMENTS
    // -------------------------------------------------------------------------
    console.log("\n🩺 Seeding Clinical Departments & Doctor Specialties...");

    const deptCardiology = await Department.create({
      organizationId: org._id,
      clinicId: clinic._id,
      name: "Cardiology & Vascular Medicine",
      code: "CARD",
      description: "Comprehensive cardiovascular diagnosis, intervention, and preventive care.",
      headDoctorId: drSarahUser._id,
      isActive: true,
    });

    const deptEmergency = await Department.create({
      organizationId: org._id,
      clinicId: clinic._id,
      name: "Emergency & Critical Care Medicine",
      code: "EMERG",
      description: "24/7 Level 1 Emergency trauma response and Intensive Care Unit.",
      headDoctorId: drMarcusUser._id,
      isActive: true,
    });

    const deptInternal = await Department.create({
      organizationId: org._id,
      clinicId: clinic._id,
      name: "Internal Medicine",
      code: "INTMED",
      description: "Primary care, chronic disease management, and inpatient care.",
      headDoctorId: drPriyaUser._id,
      isActive: true,
    });

    const deptNeurology = await Department.create({
      organizationId: org._id,
      clinicId: clinic._id,
      name: "Neurology & Brain Sciences",
      code: "NEURO",
      description: "Neurovascular, epilepsy, stroke, and neuromuscular disorders.",
      headDoctorId: drChenUser._id,
      isActive: true,
    });

    // Doctor Profiles
    const drSarahDoc = await Doctor.create({
      userId: drSarahUser._id,
      organizationId: org._id,
      specialization: "Cardiology",
      qualification: "MD, FACC (Harvard Medical School)",
      experience_years: 14,
      fees: 150,
      timings: JSON.stringify({ start: "09:00", end: "17:00" }),
      working_days: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]),
      description: "Chief of Cardiology specializing in interventional cardiology and preventive lipidology.",
      rating: 4.9,
      reviewsCount: 128,
      languages: ["English", "Spanish"],
    });

    const drMarcusDoc = await Doctor.create({
      userId: drMarcusUser._id,
      organizationId: org._id,
      specialization: "Emergency Medicine & Pulmonology",
      qualification: "MD, FCCP (Johns Hopkins)",
      experience_years: 16,
      fees: 200,
      timings: JSON.stringify({ start: "08:00", end: "20:00" }),
      working_days: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]),
      description: "Director of Emergency Pavilion and Critical Care pulmonologist.",
      rating: 4.85,
      reviewsCount: 94,
      languages: ["English"],
    });

    const drPriyaDoc = await Doctor.create({
      userId: drPriyaUser._id,
      organizationId: org._id,
      specialization: "Internal Medicine & Diabetology",
      qualification: "MD, FACP (Stanford Medicine)",
      experience_years: 11,
      fees: 120,
      timings: JSON.stringify({ start: "09:00", end: "16:00" }),
      working_days: JSON.stringify(["Monday", "Wednesday", "Thursday", "Friday"]),
      description: "Expert in metabolic syndrome, adult inpatient care, and complex diabetes management.",
      rating: 4.92,
      reviewsCount: 142,
      languages: ["English", "Hindi"],
    });

    const drChenDoc = await Doctor.create({
      userId: drChenUser._id,
      organizationId: org._id,
      specialization: "Neurology",
      qualification: "MD, PhD (UCSF)",
      experience_years: 15,
      fees: 180,
      timings: JSON.stringify({ start: "10:00", end: "18:00" }),
      working_days: JSON.stringify(["Tuesday", "Thursday", "Friday"]),
      description: "Neurologist with sub-specialization in acute stroke treatment and seizure disorders.",
      rating: 4.88,
      reviewsCount: 76,
      languages: ["English", "Mandarin"],
    });

    // Doctor Assignments
    await DoctorAssignment.create({
      doctorId: drSarahUser._id,
      clinicId: clinic._id,
      organizationId: org._id,
      workingHours: "09:00 - 17:00",
      fees: 150,
      appointmentDuration: 20,
      isActive: true,
    });

    await DoctorAssignment.create({
      doctorId: drMarcusUser._id,
      clinicId: clinic._id,
      organizationId: org._id,
      workingHours: "08:00 - 20:00",
      fees: 200,
      appointmentDuration: 15,
      isActive: true,
    });

    await DoctorAssignment.create({
      doctorId: drPriyaUser._id,
      clinicId: clinic._id,
      organizationId: org._id,
      workingHours: "09:00 - 16:00",
      fees: 120,
      appointmentDuration: 15,
      isActive: true,
    });

    await DoctorAssignment.create({
      doctorId: drChenUser._id,
      clinicId: clinic._id,
      organizationId: org._id,
      workingHours: "10:00 - 18:00",
      fees: 180,
      appointmentDuration: 30,
      isActive: true,
    });

    // Receptionist details
    await Receptionist.create({
      userId: receptionLisaUser._id,
      organizationId: org._id,
      clinicId: clinic._id,
      shift: "Morning (07:00 - 15:30)",
    });

    // -------------------------------------------------------------------------
    // 5. PATIENTS
    // -------------------------------------------------------------------------
    console.log("\n📋 Seeding Patient Records & Medical Profiles...");

    const johnPatient = await Patient.create({
      userId: johnUser._id,
      organizationId: org._id,
      dob: new Date("1972-04-12"),
      gender: "male",
      address: "450 Sutter Street, Apt 12B, San Francisco, CA",
      allergies: ["Penicillin"],
      conditions: ["Essential Hypertension", "Hyperlipidemia"],
      medicalNotes: "Compliant with antihypertensive regimens. Moderate exercise weekly.",
    });

    const mariaPatient = await Patient.create({
      userId: mariaUser._id,
      organizationId: org._id,
      dob: new Date("1988-09-24"),
      gender: "female",
      address: "1200 Market Street, San Francisco, CA",
      allergies: ["Sulfa Drugs", "Aspirin"],
      conditions: ["Severe Bronchial Asthma", "Acute Bronchitis"],
      medicalNotes: "Requires frequent nebulization during cold seasons. History of ICU observation.",
    });

    const robertSmithPatient = await Patient.create({
      userId: robertSmithUser._id,
      organizationId: org._id,
      dob: new Date("1959-11-05"),
      gender: "male",
      address: "888 Brannan Street, San Francisco, CA",
      allergies: [],
      conditions: ["Type 2 Diabetes Mellitus", "Post-Ischemic Stroke Recovery"],
      medicalNotes: "Admitted for glycemic optimization and stroke rehab protocol.",
    });

    const emilyDavisPatient = await Patient.create({
      userId: emilyDavisUser._id,
      organizationId: org._id,
      dob: new Date("1997-02-18"),
      gender: "female",
      address: "333 Post Street, San Francisco, CA",
      allergies: ["Latex"],
      conditions: ["Episodic Migraine"],
      medicalNotes: "Annual executive wellness assessment candidate.",
    });

    const jamesWilsonPatient = await Patient.create({
      userId: jamesWilsonUser._id,
      organizationId: org._id,
      dob: new Date("1981-06-30"),
      gender: "male",
      address: "55 4th Street, San Francisco, CA",
      allergies: ["Codeine"],
      conditions: ["Acute Appendicitis Post-Op"],
      medicalNotes: "Post laparoscopic appendectomy Day 2 recovery.",
    });

    // -------------------------------------------------------------------------
    // 6. PHARMACY CATALOG (MEDICINES)
    // -------------------------------------------------------------------------
    console.log("\n💊 Seeding Pharmacy Inventory & Medications...");

    const medLisinopril = await Medicine.create({
      clinicId: clinic._id,
      name: "Lisinopril 10mg Tablets",
      genericName: "Lisinopril",
      stockQuantity: 250,
      price: 25,
      costPrice: 10,
      expiryDate: new Date("2027-12-31"),
      batchNumber: "LIS-2026-A1",
    });

    const medAtorvastatin = await Medicine.create({
      clinicId: clinic._id,
      name: "Atorvastatin 20mg Film-coated",
      genericName: "Atorvastatin Calcium",
      stockQuantity: 180,
      price: 35,
      costPrice: 15,
      expiryDate: new Date("2027-10-15"),
      batchNumber: "ATO-2026-B2",
    });

    const medAmoxicillin = await Medicine.create({
      clinicId: clinic._id,
      name: "Amoxicillin 500mg Capsules",
      genericName: "Amoxicillin Trihydrate",
      stockQuantity: 300,
      price: 18,
      costPrice: 8,
      expiryDate: new Date("2027-08-20"),
      batchNumber: "AMX-2026-C3",
    });

    const medAlbuterol = await Medicine.create({
      clinicId: clinic._id,
      name: "Albuterol HFA Inhaler 90mcg",
      genericName: "Salbutamol Sulfate",
      stockQuantity: 85,
      price: 45,
      costPrice: 20,
      expiryDate: new Date("2028-01-10"),
      batchNumber: "ALB-2026-D4",
    });

    const medMetformin = await Medicine.create({
      clinicId: clinic._id,
      name: "Metformin 850mg ER Tablets",
      genericName: "Metformin Hydrochloride",
      stockQuantity: 400,
      price: 20,
      costPrice: 7,
      expiryDate: new Date("2027-11-30"),
      batchNumber: "MET-2026-E5",
    });

    const medParacetamol = await Medicine.create({
      clinicId: clinic._id,
      name: "Paracetamol 500mg Tablets",
      genericName: "Acetaminophen",
      stockQuantity: 1000,
      price: 10,
      costPrice: 3,
      expiryDate: new Date("2028-05-15"),
      batchNumber: "PCM-2026-F6",
    });

    const medNormalSaline = await Medicine.create({
      clinicId: clinic._id,
      name: "IV Normal Saline 0.9% 500ml",
      genericName: "Sodium Chloride Solution",
      stockQuantity: 150,
      price: 30,
      costPrice: 12,
      expiryDate: new Date("2027-09-01"),
      batchNumber: "SAL-2026-G7",
    });

    // -------------------------------------------------------------------------
    // 8. DIAGNOSTIC LAB TESTS CATALOG
    // -------------------------------------------------------------------------
    console.log("\n🔬 Seeding Diagnostic Lab Catalog & Master Tests...");

    const testCBC = await LabTest.create({
      clinicId: clinic._id,
      name: "Complete Blood Count with Differential (CBC)",
      code: "LAB-CBC-01",
      department: "Hematology",
      sampleType: "Whole Blood (EDTA)",
      price: 45,
      normalRange: "WBC: 4.5-11.0 k/uL, Hb: 13.5-17.5 g/dL, Plt: 150-450 k/uL",
    });

    const testCMP = await LabTest.create({
      clinicId: clinic._id,
      name: "Comprehensive Metabolic Panel (CMP)",
      code: "LAB-CMP-02",
      department: "Biochemistry",
      sampleType: "Serum",
      price: 75,
      normalRange: "Glucose: 70-99 mg/dL, BUN: 7-20 mg/dL, Creatinine: 0.6-1.2 mg/dL",
    });

    const testLipid = await LabTest.create({
      clinicId: clinic._id,
      name: "Lipid Profile Panel",
      code: "LAB-LIP-03",
      department: "Biochemistry",
      sampleType: "Serum (Fasting)",
      price: 60,
      normalRange: "Cholesterol: <200 mg/dL, Triglycerides: <150 mg/dL, HDL: >40 mg/dL, LDL: <100 mg/dL",
    });

    const testHbA1c = await LabTest.create({
      clinicId: clinic._id,
      name: "HbA1c Glycated Hemoglobin",
      code: "LAB-A1C-04",
      department: "Endocrinology",
      sampleType: "Whole Blood",
      price: 50,
      normalRange: "< 5.7% (Normal), 5.7-6.4% (Prediabetes), >= 6.5% (Diabetes)",
    });

    const testTroponin = await LabTest.create({
      clinicId: clinic._id,
      name: "High-Sensitivity Troponin I",
      code: "LAB-TROP-05",
      department: "Cardiology",
      sampleType: "Serum",
      price: 110,
      normalRange: "< 0.04 ng/mL",
    });

    const testXRay = await LabTest.create({
      clinicId: clinic._id,
      name: "Chest Radiograph PA View (Digital X-Ray)",
      code: "RAD-CXR-06",
      department: "Radiology",
      sampleType: "Radiograph",
      price: 120,
      normalRange: "Clear lung fields, normal cardiothoracic ratio",
    });

    // -------------------------------------------------------------------------
    // 9. END-TO-END CLINICAL WORKFLOWS (Encounters, Appointments, Vitals, Notes, MAR, Lab Orders)
    // -------------------------------------------------------------------------
    console.log("\n⚡ Seeding Active Clinical Workflows & Real-time Data Streams...");

    // ------------------- WORKFLOW 1: JOHN DOE (OPD Consultation - Yesterday) -------------------
    const yesterdayDate = new Date(Date.now() - 24 * 3600 * 1000);
    
    const johnAppt = await Appointment.create({
      clinicId: clinic._id,
      doctorId: drSarahUser._id,
      patientId: johnPatient._id,
      appointmentTime: yesterdayDate,
      appointmentType: "walk-in",
      status: "completed",
      tokenNumber: 101,
      queuePosition: 1,
      notes: "Patient reports intermittent tightness in chest during morning exercise.",
      symptoms: "Chest tightness, mild fatigue",
      diagnosis: "Essential (primary) hypertension & Hyperlipidemia",
      prescriptions: [
        { name: "Lisinopril 10mg Tablets", dosage: "10mg", duration: "30 days" },
        { name: "Atorvastatin 20mg Film-coated", dosage: "20mg", duration: "30 days" },
      ],
      createdAt: yesterdayDate,
    });

    const johnEncounter = await Encounter.create({
      organizationId: org._id,
      clinicId: clinic._id,
      appointmentId: johnAppt._id,
      patientId: johnPatient._id,
      doctorId: drSarahUser._id,
      encounterType: "opd",
      status: "completed",
      startedAt: yesterdayDate,
      endedAt: new Date(yesterdayDate.getTime() + 45 * 60 * 1000),
      createdAt: yesterdayDate,
    });

    // Observations / Vitals
    const obsJohnBP = await Observation.create({
      organizationId: org._id,
      clinicId: clinic._id,
      encounterId: johnEncounter._id,
      patientId: johnPatient._id,
      recordedBy: drSarahUser._id,
      code: "BP",
      name: "Blood Pressure",
      value: "145/92",
      unit: "mmHg",
      referenceRange: "< 120/80",
      recordedAt: yesterdayDate,
    });

    const obsJohnHR = await Observation.create({
      organizationId: org._id,
      clinicId: clinic._id,
      encounterId: johnEncounter._id,
      patientId: johnPatient._id,
      recordedBy: drSarahUser._id,
      code: "HR",
      name: "Heart Rate",
      value: "84",
      unit: "bpm",
      referenceRange: "60-100",
      recordedAt: yesterdayDate,
    });

    await ObservationScore.create({
      organizationId: org._id,
      clinicId: clinic._id,
      encounterId: johnEncounter._id,
      patientId: johnPatient._id,
      algorithmId: "NEWS2",
      algorithmVersion: "1.2.0",
      totalScore: 2,
      riskCategory: "Low-Medium",
      isComplete: true,
      observationIds: [obsJohnBP._id, obsJohnHR._id],
      evaluatedAt: yesterdayDate,
    });

    // Prescriptions
    const johnRx1 = await Prescription.create({
      organizationId: org._id,
      clinicId: clinic._id,
      encounterId: johnEncounter._id,
      patientId: johnPatient._id,
      doctorId: drSarahUser._id,
      medicineId: medLisinopril._id,
      medicineName: "Lisinopril 10mg Tablets",
      dosage: "10mg",
      frequency: "1-0-0",
      duration: "30 days",
      instructions: "Take once daily in the morning after food.",
      status: "active",
    });

    const johnRx2 = await Prescription.create({
      organizationId: org._id,
      clinicId: clinic._id,
      encounterId: johnEncounter._id,
      patientId: johnPatient._id,
      doctorId: drSarahUser._id,
      medicineId: medAtorvastatin._id,
      medicineName: "Atorvastatin 20mg Film-coated",
      dosage: "20mg",
      frequency: "0-0-1",
      duration: "30 days",
      instructions: "Take at bedtime.",
      status: "active",
    });

    // Lab Order (Lipid Profile - Completed with high LDL)
    const johnLabOrder = await LabOrder.create({
      organizationId: org._id,
      clinicId: clinic._id,
      encounterId: johnEncounter._id,
      patientId: johnPatient._id,
      testId: testLipid._id,
      priority: "routine",
      clinicalReason: "Evaluate hyperlipidemia status baseline",
      orderedBy: drSarahUser._id,
      doctorId: drSarahUser._id,
      collectedBy: labRobertUser._id,
      resultedBy: labRobertUser._id,
      status: "result-uploaded",
      orderDate: yesterdayDate,
      sampleCollectedAt: yesterdayDate,
      processingStartedAt: yesterdayDate,
      resultedAt: yesterdayDate,
      completedDate: yesterdayDate,
      resultValue: "Total Cholesterol: 240 mg/dL, Triglycerides: 180 mg/dL, HDL: 38 mg/dL, LDL: 166 mg/dL",
      result: {
        value: "240",
        unit: "mg/dL",
        referenceRange: "< 200",
        interpretation: "high",
        isAbnormal: true,
        notes: "Marked elevation in LDL-C and Total Cholesterol. Statin therapy initiated.",
      },
    });

    // SOAP Clinical Note
    const johnClinicalNote = await ClinicalNote.create({
      organizationId: org._id,
      clinicId: clinic._id,
      encounterId: johnEncounter._id,
      patientId: johnPatient._id,
      doctorId: drSarahUser._id,
      version: 1,
      isLatest: true,
      subjective: {
        chiefComplaint: "Intermittent exertional chest tightness",
        historyOfPresentIllness: "54-year-old male with history of untreated hypertension presenting with chest pressure during jogging.",
        symptoms: ["Chest tightness", "Mild shortness of breath on exertion"],
      },
      objective: {
        observationIds: [obsJohnBP._id, obsJohnHR._id],
        physicalExamination: "BP 145/92. S1, S2 clear. Lungs clear to auscultation bilaterally. No peripheral edema.",
      },
      assessment: {
        diagnoses: [
          { code: "I10", codingSystem: "ICD-10", description: "Essential (primary) hypertension", status: "active" },
          { code: "E78.5", codingSystem: "ICD-10", description: "Hyperlipidemia, unspecified", status: "active" },
        ],
        severity: "moderate",
      },
      plan: {
        treatmentPlan: "Initiate Lisinopril 10mg daily + Atorvastatin 20mg at bedtime. Lifestyle modifications discussed.",
        prescriptionIds: [johnRx1._id, johnRx2._id],
        labOrderIds: [johnLabOrder._id],
        followUpDate: new Date(Date.now() + 14 * 24 * 3600 * 1000),
        followUpInstructions: "Recheck blood pressure and lipid panel in 2 weeks.",
      },
      status: "signed",
      signature: {
        signerId: drSarahUser._id,
        signerName: "Dr. Sarah Jenkins, MD",
        signedAt: yesterdayDate,
        signingMethod: "RS256_JWT",
      },
      createdAt: yesterdayDate,
    });

    // CDS Evaluation for John Doe
    await CDSEvaluation.create({
      organizationId: org._id,
      clinicId: clinic._id,
      encounterId: johnEncounter._id,
      patientId: johnPatient._id,
      prescriptionIds: [johnRx1._id, johnRx2._id],
      engineVersion: "1.4.2",
      terminologyVersion: "2026.07",
      interactionDatasetVersion: "2026.07.22",
      findings: [
        { ruleId: "HTN-FIRST-LINE", title: "ACE Inhibitor First Line", severity: "info", text: "Lisinopril is appropriate first-line therapy for Stage 1 Hypertension in non-black patients." }
      ],
      clinicianDecision: "accepted",
      metrics: { durationMs: 14, rulesExecuted: 18, findingsCount: 1 },
      evaluatedAt: yesterdayDate,
    });

    // Paid Invoice for John Doe
    await Invoice.create({
      invoiceNumber: "INV-2026-0001",
      patientId: johnPatient._id,
      appointmentId: johnAppt._id,
      clinicId: clinic._id,
      doctorId: drSarahUser._id,
      items: [
        { description: "Cardiology OPD Consultation Fee", amount: 150, quantity: 1 },
        { description: "Lipid Profile Diagnostic Test", amount: 60, quantity: 1 },
      ],
      subtotal: 210,
      tax: 10,
      discount: 0,
      totalAmount: 220,
      status: "paid",
      paymentMethod: "card",
      paymentDate: yesterdayDate,
      createdAt: yesterdayDate,
    });

    // ------------------- WORKFLOW 2: MARIA GARCIA (Active ICU / Emergency - Today) -------------------
    const nowTime = new Date();

    const mariaAppt = await Appointment.create({
      clinicId: clinic._id,
      doctorId: drMarcusUser._id,
      patientId: mariaPatient._id,
      appointmentTime: nowTime,
      appointmentType: "online",
      status: "in-consultation",
      tokenNumber: 201,
      queuePosition: 1,
      notes: "Emergency transport patient admitted to ICU Bed 102 with severe respiratory distress.",
      symptoms: "Wheezing, dyspnea, SpO2 drop",
      diagnosis: "Acute Severe Asthma Exacerbation & Hypoxia",
      prescriptions: [
        { name: "Albuterol HFA Inhaler 90mcg", dosage: "2 puffs q4h", duration: "7 days" },
        { name: "Amoxicillin 500mg Capsules", dosage: "500mg", duration: "7 days" },
      ],
      createdAt: nowTime,
    });

    const mariaEncounter = await Encounter.create({
      organizationId: org._id,
      clinicId: clinic._id,
      appointmentId: mariaAppt._id,
      patientId: mariaPatient._id,
      doctorId: drMarcusUser._id,
      encounterType: "emergency",
      status: "in_progress",
      startedAt: new Date(nowTime.getTime() - 2 * 3600 * 1000),
      createdAt: nowTime,
    });

    // Critical Vitals / Observations for Maria Garcia
    const obsMariaBP = await Observation.create({
      organizationId: org._id,
      clinicId: clinic._id,
      encounterId: mariaEncounter._id,
      patientId: mariaPatient._id,
      recordedBy: nurseEmilyUser._id,
      code: "BP",
      name: "Blood Pressure",
      value: "110/70",
      unit: "mmHg",
      referenceRange: "120/80",
      recordedAt: nowTime,
    });

    const obsMariaHR = await Observation.create({
      organizationId: org._id,
      clinicId: clinic._id,
      encounterId: mariaEncounter._id,
      patientId: mariaPatient._id,
      recordedBy: nurseEmilyUser._id,
      code: "HR",
      name: "Heart Rate",
      value: "114",
      unit: "bpm",
      referenceRange: "60-100",
      recordedAt: nowTime,
    });

    const obsMariaSpO2 = await Observation.create({
      organizationId: org._id,
      clinicId: clinic._id,
      encounterId: mariaEncounter._id,
      patientId: mariaPatient._id,
      recordedBy: nurseEmilyUser._id,
      code: "SPO2",
      name: "Oxygen Saturation",
      value: "89",
      unit: "%",
      referenceRange: "95-100",
      recordedAt: nowTime,
    });

    const obsMariaRR = await Observation.create({
      organizationId: org._id,
      clinicId: clinic._id,
      encounterId: mariaEncounter._id,
      patientId: mariaPatient._id,
      recordedBy: nurseEmilyUser._id,
      code: "RR",
      name: "Respiratory Rate",
      value: "26",
      unit: "/min",
      referenceRange: "12-20",
      recordedAt: nowTime,
    });

    // NEWS2 Score & Critical Alert
    const mariaScore = await ObservationScore.create({
      organizationId: org._id,
      clinicId: clinic._id,
      encounterId: mariaEncounter._id,
      patientId: mariaPatient._id,
      algorithmId: "NEWS2",
      algorithmVersion: "1.2.0",
      totalScore: 8,
      riskCategory: "High",
      isComplete: true,
      observationIds: [obsMariaBP._id, obsMariaHR._id, obsMariaSpO2._id, obsMariaRR._id],
      evaluatedAt: nowTime,
    });

    const mariaAlert = await ObservationAlert.create({
      organizationId: org._id,
      clinicId: clinic._id,
      encounterId: mariaEncounter._id,
      patientId: mariaPatient._id,
      scoreId: mariaScore._id,
      severity: "emergency",
      message: "HIGH RISK NEWS2 SCORE 8 TRIGGERED: Patient SpO2 dropped to 89% with severe Tachypnea (26/min). Immediate clinical response required.",
      recommendedAction: "Escalate to ICU Senior Registrar. Increase Oxygen flow to 6L/min via mask and prepare nebulization.",
      status: "open",
      createdAt: nowTime,
    });

    // Prescriptions for Maria
    const mariaRx1 = await Prescription.create({
      organizationId: org._id,
      clinicId: clinic._id,
      encounterId: mariaEncounter._id,
      patientId: mariaPatient._id,
      doctorId: drMarcusUser._id,
      medicineId: medAlbuterol._id,
      medicineName: "Albuterol HFA Inhaler 90mcg",
      dosage: "2 puffs",
      frequency: "q4h",
      duration: "7 days",
      instructions: "Inhale via spacer q4h PRN wheezing.",
      status: "active",
    });

    const mariaRx2 = await Prescription.create({
      organizationId: org._id,
      clinicId: clinic._id,
      encounterId: mariaEncounter._id,
      patientId: mariaPatient._id,
      doctorId: drMarcusUser._id,
      medicineId: medAmoxicillin._id,
      medicineName: "Amoxicillin 500mg Capsules",
      dosage: "500mg",
      frequency: "1-0-1",
      duration: "7 days",
      instructions: "Take with full glass of water.",
      status: "active",
    });

    // Urgent Lab Orders for Maria
    const mariaLabCBC = await LabOrder.create({
      organizationId: org._id,
      clinicId: clinic._id,
      encounterId: mariaEncounter._id,
      patientId: mariaPatient._id,
      testId: testCBC._id,
      priority: "stat",
      clinicalReason: "Rule out acute infection / leukocytosis in status asthmaticus",
      orderedBy: drMarcusUser._id,
      doctorId: drMarcusUser._id,
      collectedBy: nurseEmilyUser._id,
      status: "processing",
      orderDate: new Date(nowTime.getTime() - 90 * 60 * 1000),
      sampleCollectedAt: new Date(nowTime.getTime() - 60 * 60 * 1000),
      processingStartedAt: new Date(nowTime.getTime() - 30 * 60 * 1000),
    });

    const mariaLabXRay = await LabOrder.create({
      organizationId: org._id,
      clinicId: clinic._id,
      encounterId: mariaEncounter._id,
      patientId: mariaPatient._id,
      testId: testXRay._id,
      priority: "urgent",
      clinicalReason: "Rule out pneumothorax or consolidation in severe asthma",
      orderedBy: drMarcusUser._id,
      doctorId: drMarcusUser._id,
      status: "sample-collected",
      orderDate: new Date(nowTime.getTime() - 80 * 60 * 1000),
      sampleCollectedAt: new Date(nowTime.getTime() - 40 * 60 * 1000),
    });

    // Pending Unpaid Invoice for Maria
    await Invoice.create({
      invoiceNumber: "INV-2026-0002",
      patientId: mariaPatient._id,
      appointmentId: mariaAppt._id,
      clinicId: clinic._id,
      doctorId: drMarcusUser._id,
      items: [
        { description: "Urgent Clinic Consultation", amount: 500, quantity: 1 },
        { description: "High-Flow Oxygen & Nebulization Services", amount: 250, quantity: 1 },
        { description: "STAT Complete Blood Count (CBC)", amount: 45, quantity: 1 },
        { description: "Digital Chest X-Ray PA View", amount: 120, quantity: 1 },
      ],
      subtotal: 915,
      tax: 0,
      discount: 0,
      totalAmount: 915,
      status: "unpaid",
      createdAt: nowTime,
    });

    // ------------------- WORKFLOW 3: ROBERT SMITH (Outpatient Chronic Care) -------------------
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000);

    const robertEncounter = await Encounter.create({
      organizationId: org._id,
      clinicId: clinic._id,
      patientId: robertSmithPatient._id,
      doctorId: drPriyaUser._id,
      encounterType: "opd",
      status: "closed",
      startedAt: threeDaysAgo,
      endedAt: nowTime,
      createdAt: threeDaysAgo,
    });

    const robertRx = await Prescription.create({
      organizationId: org._id,
      clinicId: clinic._id,
      encounterId: robertEncounter._id,
      patientId: robertSmithPatient._id,
      doctorId: drPriyaUser._id,
      medicineId: medMetformin._id,
      medicineName: "Metformin 850mg ER Tablets",
      dosage: "850mg",
      frequency: "1-0-1",
      duration: "30 days",
      instructions: "Take twice daily after major meals.",
      status: "dispensed",
    });

    const robertLabOrder = await LabOrder.create({
      organizationId: org._id,
      clinicId: clinic._id,
      encounterId: robertEncounter._id,
      patientId: robertSmithPatient._id,
      testId: testHbA1c._id,
      priority: "routine",
      clinicalReason: "Baseline glycemic status post ischemic stroke",
      orderedBy: drPriyaUser._id,
      doctorId: drPriyaUser._id,
      collectedBy: labRobertUser._id,
      resultedBy: labRobertUser._id,
      status: "result-uploaded",
      orderDate: threeDaysAgo,
      sampleCollectedAt: threeDaysAgo,
      resultedAt: yesterdayDate,
      completedDate: yesterdayDate,
      resultValue: "HbA1c: 7.8%",
      result: {
        value: "7.8",
        unit: "%",
        referenceRange: "< 5.7",
        interpretation: "high",
        isAbnormal: true,
        notes: "Suboptimal glycemic control. Metformin ER escalated to 850mg BD.",
      },
    });

    // Paid Invoice via Insurance for Robert Smith
    await Invoice.create({
      invoiceNumber: "INV-2026-0003",
      patientId: robertSmithPatient._id,
      clinicId: clinic._id,
      doctorId: drPriyaUser._id,
      items: [
        { description: "Specialist Comprehensive Consultation", amount: 800, quantity: 1 },
        { description: "Outpatient Physical Therapy & Rehabilitation", amount: 650, quantity: 1 },
        { description: "Endocrinology Consultations & Labs", amount: 450, quantity: 1 },
      ],
      subtotal: 1900,
      tax: 0,
      discount: 0,
      totalAmount: 1900,
      status: "paid",
      paymentMethod: "insurance",
      paymentDate: nowTime,
      createdAt: threeDaysAgo,
    });

    // ------------------- WORKFLOW 4: EMILY DAVIS & JAMES WILSON (Today's OPD Queue & Post-Op) -------------------
    await Appointment.create({
      clinicId: clinic._id,
      doctorId: drPriyaUser._id,
      patientId: emilyDavisPatient._id,
      appointmentTime: new Date(nowTime.getTime() + 1 * 3600 * 1000),
      appointmentType: "reception",
      status: "confirmed",
      tokenNumber: 301,
      queuePosition: 2,
      notes: "Annual wellness checkup and routine screening.",
      symptoms: "Episodic tension headaches",
      diagnosis: "",
      prescriptions: [],
      createdAt: nowTime,
    });

    await Appointment.create({
      clinicId: clinic._id,
      doctorId: drMarcusUser._id,
      patientId: jamesWilsonPatient._id,
      appointmentTime: new Date(nowTime.getTime() + 3 * 3600 * 1000),
      appointmentType: "qr",
      status: "checked-in",
      tokenNumber: 302,
      queuePosition: 3,
      notes: "Post-op laparoscopic appendectomy day 2 wound check.",
      symptoms: "Mild surgical incision tenderness",
      diagnosis: "Post-appendectomy Day 2 recovery",
      prescriptions: [],
      createdAt: nowTime,
    });

    // -------------------------------------------------------------------------
    // 10. CLINICAL TASKS & SYSTEM NOTIFICATIONS
    // -------------------------------------------------------------------------
    console.log("\n📌 Seeding Clinical Tasks & Real-time Notifications...");

    await TaskModel.create({
      organizationId: org._id,
      title: "Evaluate Maria Garcia SpO2 response after nebulization",
      description: "Check repeat SpO2 and vitals values post 2nd Albuterol dose.",
      status: "in_progress",
      priority: "urgent",
      dueDate: new Date(nowTime.getTime() + 1 * 3600 * 1000),
      assignedTo: drMarcusUser._id,
      createdBy: nurseEmilyUser._id,
    });

    await TaskModel.create({
      organizationId: org._id,
      title: "Process STAT CBC & Chest X-Ray for Maria Garcia",
      description: "Priority processing requested by Dr. Marcus Vance for acute asthma patient.",
      status: "todo",
      priority: "high",
      dueDate: new Date(nowTime.getTime() + 30 * 60 * 1000),
      assignedTo: labRobertUser._id,
      createdBy: drMarcusUser._id,
    });

    await TaskModel.create({
      organizationId: org._id,
      title: "Verify insurance authorization for Robert Smith",
      description: "Insurance pre-authorization form verified and payment settled.",
      status: "completed",
      priority: "medium",
      assignedTo: hospitalAdmin._id,
      createdBy: drPriyaUser._id,
    });

    // Notifications
    const notif1 = await Notification.create({
      organizationId: org._id,
      createdBy: nurseEmilyUser._id,
      targetUser: drMarcusUser._id,
      category: "patient",
      type: "CRITICAL_OBSERVATION_ALERT",
      title: "HIGH RISK NEWS2 SCORE - MARIA GARCIA",
      message: "Patient Maria Garcia SpO2 dropped to 89%. Immediate review requested.",
      priority: "urgent",
      severity: "error",
      actionUrl: "/dashboard/consultations",
      entityType: "ObservationAlert",
      entityId: mariaAlert._id.toString(),
      createdAt: nowTime,
    });

    await NotificationDelivery.create({
      notificationId: notif1._id,
      channel: "inApp",
      recipient: drMarcusUser.email!,
      status: "delivered",
      sentAt: nowTime,
    });

    const notif2 = await Notification.create({
      organizationId: org._id,
      createdBy: drMarcusUser._id,
      targetUser: labRobertUser._id,
      category: "task",
      type: "STAT_LAB_ORDER",
      title: "STAT Lab Order Placed",
      message: "STAT Complete Blood Count (CBC) ordered for Maria Garcia (ICU Bed 102).",
      priority: "high",
      severity: "warning",
      actionUrl: "/lab-orders",
      entityType: "LabOrder",
      entityId: mariaLabCBC._id.toString(),
      createdAt: nowTime,
    });

    await NotificationDelivery.create({
      notificationId: notif2._id,
      channel: "inApp",
      recipient: labRobertUser.email!,
      status: "delivered",
      sentAt: nowTime,
    });

    // User Notification Preferences
    await NotificationPreference.create({
      userId: rootAdmin._id,
      organizationId: org._id,
      channels: { email: true, inApp: true },
      categories: { auth: true, organization: true, team: true, task: true, patient: true, billing: true, security: true, system: true },
    });

    await NotificationPreference.create({
      userId: drMarcusUser._id,
      organizationId: org._id,
      channels: { email: true, inApp: true },
      categories: { auth: true, organization: true, team: true, task: true, patient: true, billing: true, security: true, system: true },
    });

    // -------------------------------------------------------------------------
    // 11. AUDIT TRAIL & ATOMIC COUNTERS
    // -------------------------------------------------------------------------
    console.log("\n🛡️ Seeding Audit Trail & Counter Sequences...");

    await AuditLog.create({
      userId: rootAdmin._id,
      action: "DATABASE_PURGE_AND_RESEED",
      targetId: org._id,
      targetModel: "Organization",
      details: {
        reason: "Full system reseed requested for realistic end-to-end clinical workflow testing.",
        collectionsSeeded: 37,
        timestamp: nowTime,
      },
    });

    await AuditLog.create({
      userId: drSarahUser._id,
      action: "CLINICAL_NOTE_SIGNED",
      targetId: johnClinicalNote._id,
      targetModel: "ClinicalNote",
      details: { patientId: johnPatient._id, diagnosis: "Essential hypertension" },
    });

    await AuditLog.create({
      userId: drPriyaUser._id,
      action: "ENCOUNTER_COMPLETED",
      targetId: robertEncounter._id,
      targetModel: "Encounter",
      details: { patientId: robertSmithPatient._id, status: "closed" },
    });

    await Counter.create({
      id: `invoice_${org._id.toString()}_2026`,
      seq: 3,
    });

    // -------------------------------------------------------------------------
    // 12. SUMMARY & LOGIN CREDENTIALS REPORT
    // -------------------------------------------------------------------------
    console.log("\n=======================================================================");
    console.log("🎉 DATABASE SEEDED SUCCESSFULLY WITH HIGHLY REALISTIC DATA!");
    console.log("=======================================================================");
    console.log("Organization      : ANANTA Healthcare & Research Institute");
    console.log("Primary Clinic    : ANANTA Central Hospital & Emergency Pavilion");
    console.log("Departments (5)   : CARD, EMERG, INTMED, NEURO, SURG");
    console.log("Beds (6)          : ICU-101, ICU-102 (Occupied), ICU-103, GW-201 (Occupied), GW-202, VIP-301 (Occupied)");
    console.log("Patients (5)      : John Doe, Maria Garcia, Robert Smith, Emily Davis, James Wilson");
    console.log("Pharmacy Stock (7): Lisinopril, Atorvastatin, Amoxicillin, Albuterol, Metformin, Paracetamol, IV Saline");
    console.log("Lab Catalog (6)   : CBC, CMP, Lipid Profile, HbA1c, Troponin I, Chest X-Ray");
    console.log("-----------------------------------------------------------------------");
    console.log("🔑 MASTER CREDENTIALS (Password for ALL accounts: Password123!):");
    console.log("-----------------------------------------------------------------------");
    console.log("1. Root Super Admin : 21amtics177@gmail.com");
    console.log("2. Hospital Admin   : admin@ananta.health");
    console.log("3. Cardiology Lead  : dr.sarah@ananta.health");
    console.log("4. Emergency Lead   : dr.marcus@ananta.health");
    console.log("5. Internal Med     : dr.priya@ananta.health");
    console.log("6. Neurologist      : dr.chen@ananta.health");
    console.log("7. ICU Lead Nurse   : nurse.emily@ananta.health");
    console.log("8. Lead Lab Tech    : lab.robert@ananta.health");
    console.log("9. Chief Pharmacist : pharm.hannah@ananta.health");
    console.log("10. Receptionist    : reception.lisa@ananta.health");
    console.log("11. Patient Account : john.doe@gmail.com");
    console.log("=======================================================================\n");

  } catch (err) {
    console.error("❌ Seed database failed:", err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

runSeed();
