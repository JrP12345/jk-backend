import { Appointment } from "../../models/Appointment.ts";
import { issueAppointmentTrackerLink } from "../../utilities/publicTracker.ts";

/** Issue the same persisted capability a real booking returns to its patient. */
export async function trackerFixtureHeaders(appointmentId: unknown) {
  const appointment = await Appointment.findById(String(appointmentId));
  if (!appointment) throw new Error("Tracker fixture requires an existing appointment");
  const { token } = await issueAppointmentTrackerLink(appointment);
  return { "x-tracker-token": token };
}
