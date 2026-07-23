import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { User } from "./models/User.ts";
import { Organization } from "./models/Organization.ts";
import { OrgMember } from "./models/OrgMember.ts";
import { Clinic } from "./models/Clinic.ts";
import { Doctor } from "./models/Doctor.ts";
import { DoctorAssignment } from "./models/DoctorAssignment.ts";
import { Receptionist } from "./models/Receptionist.ts";
import { Patient } from "./models/Patient.ts";
import { Appointment } from "./models/Appointment.ts";
import { AuditLog } from "./models/AuditLog.ts";
import { Permission } from "./models/Permission.ts";
import { Role } from "./models/Role.ts";
import "./db.ts";

async function seed() {
  try {
    console.log("Connecting to database and dropping existing database for a clean start...");
    
    // Wait for connection to be ready
    if (mongoose.connection.readyState !== 1) {
      await new Promise((resolve) => {
        mongoose.connection.once("open", resolve);
      });
    }

    await mongoose.connection.db.dropDatabase();
    console.log("✅ Database dropped successfully.");

    // Seeding Permissions
    console.log("Seeding Permissions...");
    const permissionsData = [
      { code: "MANAGE_STAFF", name: "Manage Staff", category: "administrative", description: "Register, update and remove organization staff members." },
      { code: "VIEW_STAFF", name: "View Staff", category: "administrative", description: "View list of organization staff members." },
      { code: "MANAGE_CLINICS", name: "Manage Clinics", category: "administrative", description: "Add, update and remove clinic locations." },
      { code: "VIEW_CLINICS", name: "View Clinics", category: "administrative", description: "View clinic location details." },
      { code: "MANAGE_ORGANIZATION", name: "Manage Organization", category: "administrative", description: "Update organization details and settings." },
      { code: "VIEW_DASHBOARD", name: "View Dashboard", category: "administrative", description: "View the administrative/clinical dashboard overview." },
      { code: "VIEW_APPOINTMENTS", name: "View Appointments", category: "clinical", description: "Access patient appointments and consultation scheduler." }
    ];
    await Permission.insertMany(permissionsData);
    console.log("✅ Permissions seeded successfully.");

    // Seeding Roles
    console.log("Seeding Roles...");
    const rolesData = [
      {
        name: "admin",
        description: "Full administrator access with all system capabilities.",
        permissions: ["MANAGE_STAFF", "VIEW_STAFF", "MANAGE_CLINICS", "VIEW_CLINICS", "MANAGE_ORGANIZATION", "VIEW_DASHBOARD", "VIEW_APPOINTMENTS"],
        isSystemRole: true
      },
      {
        name: "doctor",
        description: "Clinical practitioner with access to appointments, patient profiles, and medical tools.",
        permissions: ["VIEW_STAFF", "VIEW_CLINICS", "VIEW_DASHBOARD", "VIEW_APPOINTMENTS"],
        isSystemRole: true
      },
      {
        name: "receptionist",
        description: "Front-desk personnel managing booking and clinic queues.",
        permissions: ["VIEW_STAFF", "VIEW_CLINICS", "VIEW_DASHBOARD", "VIEW_APPOINTMENTS"],
        isSystemRole: true
      },
      {
        name: "patient",
        description: "Consumer patient profile booking appointments.",
        permissions: ["VIEW_CLINICS", "VIEW_APPOINTMENTS"],
        isSystemRole: true
      }
    ];
    await Role.insertMany(rolesData);
    console.log("✅ Roles seeded successfully.");

    // 1. Create Organization
    console.log("Creating Organization...");
    const org = await Organization.create({
      name: "MedLife Care Network",
      city: "Surat",
      address: "Ring Road Medical Complex, Surat",
      phone: "+91 261 445588",
      email: "info@medlifecare.org",
      description: "MedLife Care is a unified provider network delivering primary, emergency, and specialist clinical consultation."
    });

    const hashedPassword = await bcrypt.hash("Password123", 10);

    // Helper for user generation
    const createUser = async (name, email, role, phone) => {
      return await User.create({
        name,
        email,
        password: hashedPassword,
        phone,
        role
      });
    };

    // 2. Create Admin
    console.log("Creating Admin...");
    const adminUser = await createUser("System Admin", "admin@healthos.com", "admin", "+91 9998887776");
    await OrgMember.create({
      userId: adminUser._id,
      organizationId: org._id,
      role: "admin"
    });

    // 3. Create Clinics
    console.log("Creating Clinic Locations...");
    const clinicSurat = await Clinic.create({
      organizationId: org._id,
      name: "MedLife Specialist Center",
      city: "Surat",
      address: "102 Ring Road Medical Plaza, Surat",
      phone: "+91 261 556677",
      email: "surat@medlifecare.org",
      description: "MedLife Specialist Center hosts pediatric, cardiac, and general diagnostic practitioners.",
      timings: JSON.stringify({
        Monday: [{ start: "09:00", end: "18:00" }],
        Tuesday: [{ start: "09:00", end: "18:00" }],
        Wednesday: [{ start: "09:00", end: "18:00" }],
        Thursday: [{ start: "09:00", end: "18:00" }],
        Friday: [{ start: "09:00", end: "18:00" }]
      }),
      facilities: ["Pharmacy", "Laboratory", "Parking", "Emergency Care"]
    });

    const clinicPune = await Clinic.create({
      organizationId: org._id,
      name: "MedLife Clinic Aundh",
      city: "Pune",
      address: "DP Road, Aundh, Pune",
      phone: "+91 20 445522",
      email: "aundh@medlifecare.org",
      description: "Our Pune branch is equipped with family physicians and general medicine consultants.",
      timings: JSON.stringify({
        Monday: [{ start: "09:00", end: "17:00" }],
        Tuesday: [{ start: "09:00", end: "17:00" }],
        Wednesday: [{ start: "09:00", end: "17:00" }],
        Thursday: [{ start: "09:00", end: "17:00" }],
        Friday: [{ start: "09:00", end: "17:00" }]
      }),
      facilities: ["Pharmacy", "Laboratory", "Vaccination Center"]
    });

    // 4. Create Doctor
    console.log("Creating Doctor...");
    const doctorUser = await createUser("Dr. Rajesh Mehta", "doctor@healthos.com", "doctor", "+91 9876543210");
    await OrgMember.create({
      userId: doctorUser._id,
      organizationId: org._id,
      role: "doctor"
    });
    const doctorProfile = await Doctor.create({
      userId: doctorUser._id,
      organizationId: org._id,
      specialization: "Pediatrics & Child Care",
      qualification: "MD, DCH (Pediatrics) - Mumbai University",
      experience_years: 12,
      description: "Dr. Rajesh is a highly regarded pediatrician specializing in immunizations, child growth tracking, and pediatric allergy diagnostics.",
      image_url: "",
      rating: 4.9,
      reviewsCount: 128,
      languages: ["English", "Hindi", "Gujarati"]
    });

    // Assign Doctor to BOTH Clinics
    console.log("Assigning Doctor to Clinics...");
    await DoctorAssignment.create({
      doctorId: doctorUser._id,
      clinicId: clinicSurat._id,
      organizationId: org._id,
      workingHours: JSON.stringify({
        Monday: [{ start: "09:00", end: "13:00" }],
        Wednesday: [{ start: "09:00", end: "13:00" }],
        Friday: [{ start: "09:00", end: "13:00" }]
      }),
      fees: 25,
      appointmentDuration: 15
    });

    await DoctorAssignment.create({
      doctorId: doctorUser._id,
      clinicId: clinicPune._id,
      organizationId: org._id,
      workingHours: JSON.stringify({
        Tuesday: [{ start: "10:00", end: "16:00" }],
        Thursday: [{ start: "10:00", end: "16:00" }]
      }),
      fees: 30,
      appointmentDuration: 20
    });

    // 5. Create Receptionist
    console.log("Creating Receptionist...");
    const receptionistUser = await createUser("Aarti Patel", "receptionist@healthos.com", "receptionist", "+91 9988776655");
    await OrgMember.create({
      userId: receptionistUser._id,
      organizationId: org._id,
      role: "receptionist"
    });
    await Receptionist.create({
      userId: receptionistUser._id,
      organizationId: org._id,
      clinicId: clinicSurat._id // Linked to Surat by default
    });

    // 6. Create Patients and Appointments
    console.log("Creating test Patients & Queue Appointments...");
    
    const patientData = [
      { name: "Amit Shah", email: "amit@test.com", phone: "+91 9825001122", dob: "1988-04-12", gender: "male" },
      { name: "Pooja Sharma", email: "pooja@test.com", phone: "+91 9825003344", dob: "1994-08-22", gender: "female" },
      { name: "Karan Johar", email: "karan@test.com", phone: "+91 9825005566", dob: "1972-10-05", gender: "male" },
      { name: "Sneha Patel", email: "sneha@test.com", phone: "+91 9825007788", dob: "2001-01-30", gender: "female" }
    ];

    const todayStr = new Date().toISOString().split("T")[0];

    for (let i = 0; i < patientData.length; i++) {
      const p = patientData[i];
      const pUser = await createUser(p.name, p.email, "patient", p.phone);
      const pProfile = await Patient.create({
        userId: pUser._id,
        dob: new Date(p.dob),
        gender: p.gender,
        allergies: i === 0 ? ["Penicillin"] : [],
        conditions: i === 1 ? ["Asthma"] : []
      });

      // Scheduled 1 hour apart starting from 09:00 AM
      const time = new Date(`${todayStr}T09:00:00`);
      time.setHours(time.getHours() + i);

      // Create appointment
      const token = i + 1;
      const status = i === 0 ? "checked-in" : i === 1 ? "confirmed" : "pending";

      const appt = await Appointment.create({
        clinicId: clinicSurat._id,
        doctorId: doctorUser._id,
        patientId: pProfile._id,
        appointmentTime: time,
        appointmentType: i === 3 ? "walk-in" : "online",
        status,
        tokenNumber: token,
        queuePosition: token,
        notes: `Consultation reason: Test patient slot #${token}`
      });

      // Create Audit Log
      await AuditLog.create({
        userId: adminUser._id,
        action: "APPOINTMENT_CREATE",
        targetId: appt._id,
        targetModel: "Appointment",
        details: { tokenNumber: token, status, appointmentTime: time }
      });
    }

    console.log("\n========================================================");
    console.log("🎉 MEDLIFE HEALTHOS DATABASE SEEDED SUCCESSFULLY!");
    console.log("========================================================");
    console.log("You can log in with the following default accounts:");
    console.log("Passwords for all accounts is: Password123\n");
    console.log("1. System Admin:");
    console.log("   - Email   : admin@healthos.com");
    console.log("2. Doctor (Rajesh Mehta):");
    console.log("   - Email   : doctor@healthos.com");
    console.log("3. Receptionist (Aarti Patel):");
    console.log("   - Email   : receptionist@healthos.com");
    console.log("4. Patient (Amit Shah):");
    console.log("   - Email   : amit@test.com");
    console.log("========================================================\n");

  } catch (err) {
    console.error("❌ Seeding database failed:", err);
  } finally {
    await mongoose.connection.close();
    process.exit(0);
  }
}

seed();
