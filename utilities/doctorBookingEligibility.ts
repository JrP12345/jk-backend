import mongoose from "mongoose";
import { User } from "../models/User.ts";
import { Doctor } from "../models/Doctor.ts";

/** Profile details are optional, but a disabled practitioner cannot receive new bookings. */
export async function isActiveBookingDoctor(doctorId: string): Promise<boolean> {
  if (!mongoose.Types.ObjectId.isValid(doctorId)) return false;
  const [user, disabledProfile] = await Promise.all([
    User.exists({ _id: doctorId, isActive: true }),
    Doctor.exists({ userId: doctorId, isActive: false }),
  ]);
  return Boolean(user) && !disabledProfile;
}
