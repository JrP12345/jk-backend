import type { FastifyRequest, FastifyReply } from 'fastify';
import mongoose from 'mongoose';
import { PatientFeedback } from '../models/PatientFeedback.ts';
import { Appointment } from '../models/Appointment.ts';
import { Patient } from '../models/Patient.ts';
import { Location } from '../models/Location.ts';
import { Organization } from '../models/Organization.ts';
import { PatientRelationship } from '../models/PatientRelationship.ts';
import { CrmActivity } from '../models/CrmActivity.ts';
import { AuditLog } from '../models/AuditLog.ts';
import { crmAuthority } from '../services/CrmAuthorityService.ts';
import { createCrmTask } from '../services/CrmTaskService.ts';
import { CommandError, executeRecordedCommand } from '../services/CommandReceiptService.ts';
import { getEffectivePermissions } from '../utilities/permissions.ts';
import { successResponse, errorResponse, getPaginationParams, setPaginationHeaders } from '../utilities/helpers.ts';

function failure(req: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof CommandError) return reply.code(error.statusCode).send(errorResponse(error.message));
  req.log.error({ err: error }, 'Feedback workflow could not be confirmed');
  return reply.code(503).send(errorResponse('The feedback result could not be confirmed. Retry the submitted request.'));
}
async function staffScope(req: FastifyRequest, write: boolean | 'detail' = false) {
  const authority = await crmAuthority(req);
  const permissions = await getEffectivePermissions(req.user!.role, authority.organizationId, req.user!.authVersion, true);
  const canRecord = permissions.has('MANAGE_CRM_TASKS'), canReport = permissions.has('VIEW_CRM_ANALYTICS') || permissions.has('VIEW_ANALYTICS');
  if (req.user!.role !== 'root' && (!permissions.has('VIEW_CRM') || !(write === 'detail' ? canRecord || canReport : write ? canRecord : canReport))) throw new CommandError(403, write ? 'Feedback recording permission required' : 'Feedback analytics permission required');
  return authority;
}
async function submissionAuthority(req: FastifyRequest, appointmentId: string) {
  if (!req.user || ['family_member', 'guest'].includes(req.user.role) || req.user.impersonatedBy) throw new CommandError(403, 'An authorized patient or staff session is required');
  const staff = req.user.role !== 'patient' ? await staffScope(req, true) : null;
  const appointment = await Appointment.findOne({ _id: appointmentId, ...(staff ? { organizationId: staff.organizationId, ...(staff.allLocations ? {} : { locationId: { $in: staff.locationIds } }) } : {}) });
  if (!appointment) throw new CommandError(404, 'Appointment not found in your scope');
  if (!appointment.organizationId || !await Location.exists({ _id: appointment.locationId, organizationId: appointment.organizationId, isActive: true })) throw new CommandError(404, 'Appointment branch is unavailable');
  if (!staff && !await Patient.exists({ _id: appointment.patientId, userId: req.user.id })) throw new CommandError(403, 'Feedback can only be submitted for your own appointment');
  if (appointment.status !== 'completed') throw new CommandError(409, 'Feedback requires a completed visit');
  return { appointment, source: staff ? 'staff_reported' as const : 'patient_submitted' as const };
}
function feedbackDTO(row: any) {
  return { id: String(row._id), appointmentId: String(row.appointmentId), patientId: String(row.patientId), doctorId: String(row.doctorId), locationId: String(row.locationId), rating: row.rating, npsScore: row.npsScore,
    source: row.source || 'unknown', aspectRatings: row.aspectRatings, createdAt: row.createdAt };
}
export async function submitFeedback(req: FastifyRequest, reply: FastifyReply) {
  try {
    const input = req.body as { appointmentId: string; clientRequestId?: string; rating: number; npsScore: number; comments?: string; aspectRatings?: Record<string, number> };
    await submissionAuthority(req, input.appointmentId);
    const key = input.clientRequestId || `legacy_${input.appointmentId}`;
    if (!input.clientRequestId && await PatientFeedback.exists({ appointmentId: input.appointmentId })) throw new CommandError(400, 'Feedback already submitted for this appointment');
    const result = await executeRecordedCommand(`feedback:${req.user!.id}`, key, input, async () => {
      const { appointment, source } = await submissionAuthority(req, input.appointmentId);
      const fenced = await Appointment.updateOne({ _id: appointment._id, organizationId: appointment.organizationId, patientId: appointment.patientId, locationId: appointment.locationId, status: 'completed' }, { $inc: { feedbackRevision: 1 } });
      if (!fenced.modifiedCount) throw new CommandError(409, 'The visit changed. Reload before recording feedback.');
      if (await PatientFeedback.exists({ appointmentId: appointment._id })) throw new CommandError(400, 'Feedback already submitted for this appointment');
      const feedback = await PatientFeedback.create({ organizationId: appointment.organizationId!, appointmentId: appointment._id, patientId: appointment.patientId, doctorId: appointment.doctorId, locationId: appointment.locationId,
        source, submittedBy: req.user!.id, rating: input.rating, npsScore: input.npsScore, comments: input.comments?.trim(), aspectRatings: input.aspectRatings });
      const org = await Organization.findById(appointment.organizationId).select('crmSettings').lean();
      if (!org) throw new CommandError(404, 'Organization not found');
      let taskId: mongoose.Types.ObjectId | undefined;
      if (input.rating <= (org.crmSettings?.feedbackRecoveryRating ?? 2)) {
        const relationship = await PatientRelationship.findOne({ organizationId: appointment.organizationId, patientId: appointment.patientId, locationId: appointment.locationId, status: 'active' }).select('ownerId').lean();
        const task = await createCrmTask({ organizationId: String(appointment.organizationId), locationId: String(appointment.locationId), patientId: String(appointment.patientId), appointmentId: appointment.id, actorId: req.user!.id,
          kind: 'crm_feedback', title: 'Review visit feedback', dueDate: new Date(Date.now() + (org.crmSettings?.defaultTaskHours ?? 24) * 3600000), assignedTo: relationship?.ownerId?.toString(), dedupeKey: `feedback:${feedback.id}:review` });
        taskId = task._id;
      }
      await CrmActivity.create({ organizationId: appointment.organizationId, locationId: appointment.locationId, patientId: appointment.patientId, appointmentId: appointment._id, actorId: req.user!.id, taskId,
        kind: 'feedback_recorded', outcome: source, eventKey: `feedback:${feedback.id}` });
      await AuditLog.create({ organizationId: appointment.organizationId, userId: req.user!.id, action: 'PATIENT_FEEDBACK_SUBMIT', targetId: feedback._id, targetModel: 'PatientFeedback', category: 'ADMIN',
        details: { appointmentId: appointment.id, source, recoveryTaskCreated: !!taskId } });
      return feedback.id;
    });
    const { appointment } = await submissionAuthority(req, input.appointmentId);
    const feedback = await PatientFeedback.findOne({ _id: result.resultId, appointmentId: appointment._id, organizationId: appointment.organizationId });
    if (!feedback) throw new CommandError(404, 'Feedback not found');
    return reply.code(result.replayed ? 200 : 201).send(successResponse({ ...feedbackDTO(feedback), replayed: result.replayed }, 'Feedback recorded.'));
  } catch (error) { return failure(req, reply, error); }
}
async function reportScope(req: FastifyRequest) {
  const authority = await staffScope(req), input = req.query as { locationId?: string; doctorId?: string; appointmentId?: string; page?: string; limit?: string; cursor?: string };
  const branches = await Location.find({ organizationId: authority.organizationId, isActive: true, ...(authority.allLocations ? {} : { _id: { $in: authority.locationIds } }), ...(input.locationId ? { $and: [{ _id: input.locationId }] } : {}) }).select('_id').limit(101).lean();
  if (branches.length > 100) throw new CommandError(400, 'Select a branch for feedback review');
  if (input.locationId && !branches.length) throw new CommandError(404, 'Branch not available');
  const org = new mongoose.Types.ObjectId(authority.organizationId);
  const filter = { locationId: { $in: branches.map(branch => branch._id) }, ...(input.doctorId ? { doctorId: new mongoose.Types.ObjectId(input.doctorId) } : {}), ...(input.appointmentId ? { appointmentId: new mongoose.Types.ObjectId(input.appointmentId) } : {}) };
  // Legacy rows need a matching canonical visit; reads never assign ownership.
  const pipeline: mongoose.PipelineStage[] = [
    { $match: { ...filter, organizationId: { $in: [org, null] } } },
    { $lookup: { from: Appointment.collection.name, let: { appointment: '$appointmentId', patient: '$patientId', branch: '$locationId', doctor: '$doctorId' }, pipeline: [{ $match: { organizationId: org, $expr: { $and: [{ $eq: ['$_id', '$$appointment'] }, { $eq: ['$patientId', '$$patient'] }, { $eq: ['$locationId', '$$branch'] }, { $eq: ['$doctorId', '$$doctor'] }] } } }, { $project: { _id: 1 } }, { $limit: 1 }], as: 'visit' } },
    { $match: { 'visit.0': { $exists: true } } },
  ];
  return { authority, input, pipeline };
}
export async function getFeedbackStats(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { pipeline } = await reportScope(req);
    const rows = await PatientFeedback.aggregate([...pipeline, { $group: { _id: { $ifNull: ['$source', 'unknown'] }, total: { $sum: 1 }, rating: { $avg: '$rating' }, promoters: { $sum: { $cond: [{ $gte: ['$npsScore', 9] }, 1, 0] } }, detractors: { $sum: { $cond: [{ $lte: ['$npsScore', 6] }, 1, 0] } }, waitTime: { $avg: '$aspectRatings.waitTime' }, doctorAttitude: { $avg: '$aspectRatings.doctorAttitude' }, cleanliness: { $avg: '$aspectRatings.cleanliness' } } }, { $sort: { _id: 1 } }]).option({ maxTimeMS: 8000 });
    const total = rows.reduce((n, row) => n + row.total, 0), round = (value: number) => Math.round(value * 100) / 100;
    return reply.send(successResponse({ totalResponses: total, averageCsatRating: total ? round(rows.reduce((n, row) => n + row.rating * row.total, 0) / total) : null,
      netPromoterScore: total ? Math.round(rows.reduce((n, row) => n + row.promoters - row.detractors, 0) / total * 100) : null, npsCategory: total ? 'Recorded survey responses' : 'No responses',
      sources: rows.map(row => ({ source: row._id, total: row.total, averageRating: round(row.rating), nps: Math.round((row.promoters - row.detractors) / row.total * 100), averageAspectRatings: { waitTime: row.waitTime, doctorAttitude: row.doctorAttitude, cleanliness: row.cleanliness } })),
      definition: 'Recorded responses in these authorized branches, separated by submission source. These scores describe respondents, not every patient. Legacy source is unknown.' }));
  } catch (error) { return failure(req, reply, error); }
}
export async function getFeedback(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { pipeline, input } = await reportScope(req), { page, limit, skip } = getPaginationParams(input);
    const [result] = await PatientFeedback.aggregate([...pipeline, { $facet: { count: [{ $count: 'total' }], items: [{ $sort: { createdAt: -1, _id: -1 } }, { $skip: skip }, { $limit: limit }, { $project: { appointmentId: 1, patientId: 1, locationId: 1, doctorId: 1, rating: 1, npsScore: 1, source: 1, aspectRatings: 1, createdAt: 1 } }] } }]).option({ maxTimeMS: 8000 });
    const totalCount = result?.count[0]?.total || 0;
    setPaginationHeaders(reply, { totalCount, totalPages: Math.ceil(totalCount / limit), currentPage: page, pageSize: limit });
    return reply.send(successResponse((result?.items || []).map(feedbackDTO)));
  } catch (error) { return failure(req, reply, error); }
}
export async function getFeedbackEligibleVisits(req: FastifyRequest, reply: FastifyReply) {
  try {
    if (!req.user || ['family_member', 'guest'].includes(req.user.role) || req.user.impersonatedBy) throw new CommandError(403, 'An authorized patient or staff session is required');
    const input = req.query as { locationId?: string; cursor?: string };
    let filter: Record<string, unknown>;
    if (req.user.role === 'patient') {
      const patient = await Patient.findOne({ userId: req.user.id }).select('_id');
      if (!patient) throw new CommandError(404, 'Patient record not found');
      filter = { patientId: patient._id, ...(input.locationId ? { locationId: new mongoose.Types.ObjectId(input.locationId) } : {}) };
    } else {
      const authority = await staffScope(req, true);
      const branches = await Location.find({ organizationId: authority.organizationId, isActive: true, ...(authority.allLocations ? {} : { _id: { $in: authority.locationIds } }), ...(input.locationId ? { $and: [{ _id: input.locationId }] } : {}) }).select('_id').limit(101).lean();
      if (branches.length > 100) throw new CommandError(400, 'Select a branch');
      if (input.locationId && !branches.length) throw new CommandError(404, 'Branch not available');
      filter = { organizationId: new mongoose.Types.ObjectId(authority.organizationId), locationId: { $in: branches.map(branch => branch._id) } };
    }
    const visits = await Appointment.aggregate([{ $match: { ...filter, status: 'completed', ...(input.cursor ? { _id: { $lt: new mongoose.Types.ObjectId(input.cursor) } } : {}) } },
      { $lookup: { from: PatientFeedback.collection.name, localField: '_id', foreignField: 'appointmentId', pipeline: [{ $project: { _id: 1 } }, { $limit: 1 }], as: 'feedback' } },
      { $match: { 'feedback.0': { $exists: false } } }, { $sort: { _id: -1 } }, { $limit: 21 }, { $project: { _id: 1, appointmentTime: 1, locationId: 1 } }]).option({ maxTimeMS: 8000 });
    return reply.send(successResponse({ items: visits.slice(0, 20).map(visit => ({ id: String(visit._id), appointmentTime: visit.appointmentTime, locationId: String(visit.locationId) })), nextCursor: visits.length > 20 ? String(visits[19]._id) : null }));
  } catch (error) { return failure(req, reply, error); }
}
export async function getVisitFeedback(req: FastifyRequest, reply: FastifyReply) {
  try {
    if (!req.user || ['family_member', 'guest'].includes(req.user.role) || req.user.impersonatedBy) throw new CommandError(403, 'An authorized patient or staff session is required');
    const appointmentId = (req.params as { id: string }).id;
    const authority = req.user.role === 'patient' ? null : await staffScope(req, 'detail');
    const appointment = await Appointment.findOne({ _id: appointmentId, ...(authority ? { organizationId: authority.organizationId, ...(authority.allLocations ? {} : { locationId: { $in: authority.locationIds } }) } : {}) });
    if (!appointment || !appointment.organizationId || !await Location.exists({ _id: appointment.locationId, organizationId: appointment.organizationId, isActive: true })) throw new CommandError(404, 'Visit not found');
    if (!authority && !await Patient.exists({ _id: appointment.patientId, userId: req.user.id })) throw new CommandError(404, 'Visit not found');
    const feedback = await PatientFeedback.findOne({ appointmentId: appointment._id, patientId: appointment.patientId, doctorId: appointment.doctorId, locationId: appointment.locationId,
      organizationId: { $in: [appointment.organizationId, null] } }).select('+comments');
    if (!feedback) throw new CommandError(404, 'Feedback not found');
    return reply.send(successResponse({ ...feedbackDTO(feedback), comments: feedback.get('comments') || '' }));
  } catch (error) { return failure(req, reply, error); }
}
export async function getOwnFeedback(req: FastifyRequest, reply: FastifyReply) {
  try {
    if (req.user?.role !== 'patient' || req.user.impersonatedBy) throw new CommandError(403, 'Your own patient session is required');
    const patient = await Patient.findOne({ userId: req.user.id }).select('_id');
    if (!patient) throw new CommandError(404, 'Patient record not found');
    const { page, limit, skip } = getPaginationParams(req.query as { page?: string; limit?: string });
    const [result] = await PatientFeedback.aggregate([{ $match: { patientId: patient._id } },
      { $lookup: { from: Appointment.collection.name, let: { visit: '$appointmentId', branch: '$locationId', org: '$organizationId' }, pipeline: [{ $match: { patientId: patient._id, $expr: { $and: [{ $eq: ['$_id', '$$visit'] }, { $eq: ['$locationId', '$$branch'] }, { $or: [{ $eq: [{ $ifNull: ['$$org', null] }, null] }, { $eq: ['$organizationId', '$$org'] }] }] } } }, { $project: { _id: 1 } }, { $limit: 1 }], as: 'visit' } },
      { $match: { 'visit.0': { $exists: true } } }, { $facet: { count: [{ $count: 'total' }], items: [{ $sort: { createdAt: -1, _id: -1 } }, { $skip: skip }, { $limit: limit }, { $project: { appointmentId: 1, patientId: 1, locationId: 1, doctorId: 1, rating: 1, npsScore: 1, source: 1, aspectRatings: 1, createdAt: 1 } }] } }]).option({ maxTimeMS: 8000 });
    const totalCount = result?.count[0]?.total || 0;
    setPaginationHeaders(reply, { totalCount, totalPages: Math.ceil(totalCount / limit), currentPage: page, pageSize: limit });
    return reply.send(successResponse((result?.items || []).map(feedbackDTO)));
  } catch (error) { return failure(req, reply, error); }
}
