import mongoose from "mongoose";
import { getActiveConsultationDoctorDayKey } from "../utilities/consultationLock.ts";

/**
 * Backfills and enforces the active-consultation lock before an application
 * deployment uses it. It deliberately aborts if legacy data already has two
 * active consultations for one doctor/day: that clinical conflict needs an
 * operator to choose which encounter remains active.
 */
async function migrateActiveConsultationLock() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required");

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 30_000,
  });

  try {
    const appointments = mongoose.connection.collection("appointments");
    const activeAppointments = await appointments
      .find(
        { status: "in-consultation" },
        { projection: { _id: 1, doctorId: 1, appointmentTime: 1, activeConsultationDoctorDayKey: 1 } },
      )
      .toArray();

    const byLockKey = new Map<string, typeof activeAppointments>();
    for (const appointment of activeAppointments) {
      if (!appointment.doctorId || !appointment.appointmentTime) {
        throw new Error(`Active appointment ${appointment._id} has no doctorId or appointmentTime`);
      }
      const key = getActiveConsultationDoctorDayKey(appointment.doctorId, appointment.appointmentTime);
      byLockKey.set(key, [...(byLockKey.get(key) || []), appointment]);
    }

    const conflicts = [...byLockKey.entries()].filter(([, appointmentsForDay]) => appointmentsForDay.length > 1);
    if (conflicts.length > 0) {
      const details = conflicts
        .map(([key, appointmentsForDay]) => `${key}: ${appointmentsForDay.map((appointment) => appointment._id).join(", ")}`)
        .join("; ");
      throw new Error(`Cannot create consultation lock: resolve duplicate active consultations first (${details})`);
    }

    if (activeAppointments.length > 0) {
      await appointments.bulkWrite(
        activeAppointments.map((appointment) => ({
          updateOne: {
            filter: { _id: appointment._id, status: "in-consultation" },
            update: {
              $set: {
                activeConsultationDoctorDayKey: getActiveConsultationDoctorDayKey(
                  appointment.doctorId,
                  appointment.appointmentTime,
                ),
              },
            },
          },
        })),
        { ordered: true },
      );
    }

    await appointments.createIndex(
      { activeConsultationDoctorDayKey: 1 },
      {
        name: "uniq_active_consultation_per_doctor_day",
        unique: true,
        sparse: true,
      },
    );

    console.log(`Consultation lock migration complete; ${activeAppointments.length} active appointment(s) backfilled.`);
  } finally {
    await mongoose.disconnect();
  }
}

migrateActiveConsultationLock().catch((error) => {
  console.error("Consultation lock migration failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
