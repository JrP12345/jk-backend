import { safeError } from "../utilities/safeError.ts";
import type { FastifyRequest, FastifyReply } from "fastify";
import { syncInquiryTask } from "../services/CrmTaskService.ts";
import { Inquiry } from "../models/Inquiry.ts";
import { Appointment } from "../models/Appointment.ts";
import { CrmActivity } from "../models/CrmActivity.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { inquiryAuthority } from "./crmInquiry.ts";
import { crmPatientAuthority } from "../services/CrmAuthorityService.ts";
import { appointmentService, AppointmentDomainError } from "../services/AppointmentService.ts";
import { registerOrganizationPatient } from "../services/PatientRegistrationService.ts";
import { CommandError, commandHash, executeRecordedCommand } from "../services/CommandReceiptService.ts";
import { requestHasAnyPermission } from "../utilities/permissions.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { eventBus } from "../events/eventBus.ts";

export async function convertInquiry(req: FastifyRequest, reply: FastifyReply) {
  try {
    const authority = await inquiryAuthority(req, (req.params as any).id), input = req.body as any;
    if (req.user?.impersonatedBy) throw new CommandError(403, "End impersonation before converting an inquiry");
    if (input.identityVerified !== true) throw new CommandError(400, "Verify the patient identity before booking");
    let effects: (() => Promise<void>)[] = [];
    const result = await executeRecordedCommand(`inquiry-conversion:${authority.organizationId}:${authority.actorId}:${authority.inquiry.id}`, input.clientRequestId, input, async () => {
      effects = [];
      const inquiry = await Inquiry.findOne({ _id: authority.inquiry._id, organizationId: authority.organizationId });
      if (!inquiry || inquiry.revision !== input.expectedRevision) throw new CommandError(409, "Inquiry changed. Reload before converting.");
      if (!["open", "in_progress"].includes(inquiry.status)) throw new CommandError(409, "Only an open inquiry can be converted. Reload its existing booking or reopen it after review.");
      if (inquiry.ownerId && String(inquiry.ownerId) !== authority.actorId && !await requestHasAnyPermission(req, "ASSIGN_CRM_TASKS")) throw new CommandError(403, "Only the inquiry owner or an authorized manager may convert it");
      if (input.patientId && input.patientDetails) throw new CommandError(400, "Select an existing patient or explicitly register a new person");
      let patientId = input.patientId || inquiry.patientId?.toString();
      if (input.patientDetails) {
        if (inquiry.patientId) throw new CommandError(409, "This inquiry already references a canonical patient. Review that record instead of creating another.");
        if (!await requestHasAnyPermission(req, "MANAGE_PATIENTS")) throw new CommandError(403, "Patient registration permission required");
        const registered = await registerOrganizationPatient(authority.organizationId, authority.actorId, { ...input.patientDetails, locationId: String(inquiry.locationId) },
          `conversion-patient-${commandHash({ clientRequestId: input.clientRequestId, inquiryId: inquiry.id }).slice(0, 64)}`);
        patientId = registered.patient.id;
      }
      if (!patientId) throw new CommandError(400, "Select a verified canonical patient or register minimum details");
      await crmPatientAuthority(req, patientId);
      if (inquiry.patientId && String(inquiry.patientId) !== patientId && !input.identityReviewReason?.trim()) throw new CommandError(400, "Record why the inquiry patient reference is being corrected");
      const booking = await appointmentService.book({ id: authority.actorId, role: req.user!.role, organizationId: authority.organizationId },
        { patientId, locationId: String(inquiry.locationId), doctorId: input.doctorId, appointmentTime: input.appointmentTime,
          appointmentType: "reception", reasonForVisit: "new_consultation", payAtLocation: input.payAtLocation, lockId: input.lockId }, authority.organizationId,
        { deferAfterCommit: effect => effects.push(effect) });
      const changed = await Inquiry.updateOne({ _id: inquiry._id, organizationId: authority.organizationId, revision: input.expectedRevision, status: { $in: ["open", "in_progress"] } },
        { $set: { patientId, appointmentId: booking.id, status: "converted", convertedAt: new Date() }, $inc: { revision: 1 } });
      if (changed.modifiedCount !== 1) throw new CommandError(409, "Inquiry conversion changed. Reload its booking before retrying.");
      await syncInquiryTask(await Inquiry.findOne({ _id: inquiry._id, organizationId: authority.organizationId }), authority.actorId);
      await CrmActivity.create({ organizationId: authority.organizationId, locationId: inquiry.locationId, inquiryId: inquiry._id, patientId, appointmentId: booking.id,
        actorId: authority.actorId, kind: "inquiry_converted", outcome: booking.status, note: input.identityReviewReason?.trim(), revision: input.expectedRevision + 1 });
      await AuditLog.create({ userId: authority.actorId, organizationId: authority.organizationId, action: "CRM_INQUIRY_CONVERTED", targetId: inquiry._id,
        targetModel: "Inquiry", category: "ADMIN", details: { appointmentId: booking.id, patientId, status: booking.status } });
      await eventBus.publishDurable({ eventId: `crm:inquiry-converted:${inquiry.id}:${input.expectedRevision + 1}`, eventType: "crm.inquiry.converted", category: "patient",
        organizationId: authority.organizationId, createdBy: authority.actorId, metadata: { inquiryId: inquiry.id, appointmentId: booking.id, patientId, locationId: String(inquiry.locationId) } });
      return booking.id;
    });
    if (!result.replayed) await Promise.allSettled(effects.map(effect => effect()));
    const appointment = await Appointment.findOne({ _id: result.resultId, organizationId: authority.organizationId, locationId: authority.inquiry.locationId })
      .select("_id patientId locationId doctorId appointmentTime status paymentStatus paymentAmount tokenNumber").lean();
    if (!appointment) throw new CommandError(409, "The recorded booking requires review. Do not create another booking.");
    return reply.code(result.replayed ? 200 : 201).send(successResponse({ inquiryId: authority.inquiry.id, appointment: { id: String(appointment._id),
      patientId: String(appointment.patientId), locationId: String(appointment.locationId), doctorId: String(appointment.doctorId), appointmentTime: appointment.appointmentTime,
      status: appointment.status, paymentStatus: appointment.paymentStatus, paymentAmount: appointment.paymentAmount, tokenNumber: appointment.tokenNumber }, replayed: result.replayed },
      appointment.status === "pending_payment" ? "Booking recorded; payment remains pending" : result.replayed ? "Existing booking restored" : "Inquiry converted to a booking"));
  } catch (error: any) {
    if (error instanceof CommandError || error instanceof AppointmentDomainError) return reply.code(error.statusCode).send(errorResponse(error.message, error instanceof CommandError ? error.details : undefined));
    if (error?.code === 11000) return reply.code(409).send(errorResponse("The booking slot or command changed. Reload before booking again."));
    req.log.error(safeError(error), "Inquiry conversion failed");
    return reply.code(503).send(errorResponse("The conversion result could not be confirmed. Retry the same request."));
  }
}
