import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Organization } from "../models/Organization.ts";
import { Clinic } from "../models/Clinic.ts";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { DomainEventOutbox } from "../models/DomainEventOutbox.ts";
import { OutboundMessage } from "../models/OutboundMessage.ts";
import { triggerTurnApproachingPacing } from "../controllers/queue.ts";

let replica: MongoMemoryReplSet;
let orgId: string, clinicId: string, doctorId: string, patientId: string;
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.disconnect();
  await mongoose.connect(replica.getUri());
  await Promise.all([Appointment, DomainEventOutbox, OutboundMessage].map(model => model.createIndexes()));
  const org = await Organization.create({ name: "Queue pacing fixture", city: "New York", timezone: "America/New_York" });
  const clinic = await Clinic.create({ organizationId: org._id, name: "Queue fixture", city: "New York" });
  const doctor = await User.create({ name: "Queue doctor", role: "doctor" });
  const user = await User.create({ name: "Queue patient", role: "patient" });
  const patient = await Patient.create({ organizationId: org._id, userId: user._id, name: "Queue patient", phone: "9876500001" });
  orgId = org.id; clinicId = clinic.id; doctorId = doctor.id; patientId = patient.id;
}, 60000);
afterAll(async () => { await mongoose.disconnect(); await replica?.stop(); });
beforeEach(async () => {
  await Promise.all([Appointment.deleteMany({}), DomainEventOutbox.deleteMany({}), OutboundMessage.deleteMany({})]);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-05T00:30:00Z"));
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const visit = (tokenNumber: number, appointmentTime = new Date("2026-10-04T20:00:00Z")) => Appointment.create({
  organizationId: orgId, clinicId, doctorId, patientId, tokenNumber, queuePosition: tokenNumber,
  appointmentTime, status: "checked-in", appointmentType: "walk-in",
});

describe("Queue pacing persistence", () => {
  it("concurrent pacing claims each of the first two patients once and preserves replay timestamps", async () => {
    const visits = await Promise.all([visit(1), visit(2), visit(3)]);
    await Promise.all(Array.from({ length: 4 }, () => triggerTurnApproachingPacing(clinicId, doctorId)));
    const before = await Appointment.findById(visits[0].id);
    expect(before?.turnApproachingNotifiedAt).toBeInstanceOf(Date);
    expect(await DomainEventOutbox.countDocuments({})).toBe(2);
    expect(await OutboundMessage.countDocuments({})).toBe(2);
    expect((await Appointment.findById(visits[2].id))?.turnApproachingNotifiedAt).toBeFalsy();
    vi.setSystemTime(new Date("2026-10-05T00:31:00Z"));
    await triggerTurnApproachingPacing(clinicId, doctorId);
    expect((await Appointment.findById(visits[0].id))?.turnApproachingNotifiedAt?.getTime()).toBe(before!.turnApproachingNotifiedAt!.getTime());
    expect(await DomainEventOutbox.countDocuments({})).toBe(2);
    expect(await OutboundMessage.countDocuments({})).toBe(2);
  });

  it("rolls back the marker and both delivery intents after an enqueue failure, then permits retry", async () => {
    const appointment = await visit(1);
    const fail = vi.spyOn(OutboundMessage, "findOneAndUpdate").mockImplementationOnce(() => { throw new Error("Injected enqueue failure"); });
    await triggerTurnApproachingPacing(clinicId, doctorId);
    expect((await Appointment.findById(appointment.id))?.turnApproachingNotifiedAt).toBeFalsy();
    expect(await DomainEventOutbox.countDocuments({})).toBe(0);
    expect(await OutboundMessage.countDocuments({})).toBe(0);
    fail.mockRestore();
    await triggerTurnApproachingPacing(clinicId, doctorId);
    expect((await Appointment.findById(appointment.id))?.turnApproachingNotifiedAt).toBeInstanceOf(Date);
    expect(await DomainEventOutbox.countDocuments({})).toBe(1);
    expect(await OutboundMessage.countDocuments({})).toBe(1);
  });

  it("uses the configured clinic day at a UTC midnight boundary", async () => {
    const today = await visit(1);
    const tomorrow = await visit(2, new Date("2026-10-05T05:00:00Z"));
    await triggerTurnApproachingPacing(clinicId, doctorId);
    expect((await Appointment.findById(today.id))?.turnApproachingNotifiedAt).toBeInstanceOf(Date);
    expect((await Appointment.findById(tomorrow.id))?.turnApproachingNotifiedAt).toBeFalsy();
    expect(await DomainEventOutbox.countDocuments({})).toBe(1);
  });
});
