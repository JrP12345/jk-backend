import type { FastifyRequest, FastifyReply } from 'fastify';
import mongoose from 'mongoose';
import { Inquiry } from '../models/Inquiry.ts';
import { Appointment } from '../models/Appointment.ts';
import { TaskModel } from '../models/Task.ts';
import { CrmActivity } from '../models/CrmActivity.ts';
import { OutboundMessage } from '../models/OutboundMessage.ts';
import { Location } from '../models/Location.ts';
import { Organization } from '../models/Organization.ts';
import { OrgMember } from '../models/OrgMember.ts';
import { User } from '../models/User.ts';
import { crmAuthority } from '../services/CrmAuthorityService.ts';
import { CRM_TASK_KINDS } from '../services/CrmTaskService.ts';
import { CommandError } from '../services/CommandReceiptService.ts';
import { withTransaction } from '../utilities/transaction.ts';
import { locationDateKey, locationDayRange } from '../utilities/locationTime.ts';
import { successResponse, errorResponse } from '../utilities/helpers.ts';

const id = (value: string) => new mongoose.Types.ObjectId(value);
const sumIf = (condition: any) => ({ $sum: { $cond: [condition, 1, 0] } });
const rate = (numerator: number, denominator: number) => denominator ? Math.round(numerator / denominator * 1000) / 10 : null;
export async function getCrmAnalytics(req: FastifyRequest, reply: FastifyReply) {
  try {
    const authority = await crmAuthority(req), input = req.query as { locationId?: string; startDate?: string; endDate?: string };
    const org = await Organization.findById(authority.organizationId).select('timezone').lean();
    const branches = await Location.find({ organizationId: authority.organizationId, isActive: true, ...(input.locationId ? { _id: input.locationId } : {}), ...(authority.allLocations ? {} : { _id: { $in: authority.locationIds, ...(input.locationId ? { $eq: input.locationId } : {}) } }) }).select('_id name timezone').limit(101).lean();
    if (input.locationId && !branches.length) throw new CommandError(404, 'Branch not available in this workspace');
    if (branches.length > 100) throw new CommandError(400, 'Select a branch for this report');
    const now = new Date(), defaultZone = branches.length === 1 ? branches[0].timezone || org?.timezone || 'Asia/Kolkata' : org?.timezone || 'Asia/Kolkata';
    const endDate = input.endDate || locationDateKey(now, defaultZone);
    const defaultStart = new Date(`${endDate}T12:00:00Z`); defaultStart.setUTCDate(defaultStart.getUTCDate() - 29);
    const startDate = input.startDate || (Number.isFinite(defaultStart.getTime()) ? defaultStart.toISOString().slice(0, 10) : '');
    const days = (Date.parse(`${endDate}T12:00:00Z`) - Date.parse(`${startDate}T12:00:00Z`)) / 86400000 + 1;
    if (!Number.isInteger(days) || days < 1 || days > 31) throw new CommandError(400, 'Choose an inclusive range of up to 31 calendar days');
    const windows = branches.map(branch => {
      const timezone = branch.timezone || org?.timezone || 'Asia/Kolkata';
      try { return { locationId: String(branch._id), name: branch.name, timezone, start: locationDayRange(startDate, timezone).start, end: locationDayRange(endDate, timezone).end }; }
      catch { throw new CommandError(400, 'Choose valid calendar dates'); }
    });
    const orgId = id(authority.organizationId), locationIds = branches.map(branch => branch._id);
    const scope = { organizationId: orgId, locationId: { $in: locationIds } };
    const period = (field: string, routing = false) => ({ $or: windows.length ? windows.map(window => ({ [routing ? 'payload.locationId' : 'locationId']: routing ? window.locationId : id(window.locationId), [field]: { $gte: window.start, $lte: field === 'createdAt' ? new Date(Math.min(window.end.getTime(), now.getTime())) : window.end } })) : [{ _id: { $exists: false } }] });
    // Sequential reads share one snapshot; no patient/contact/clinical fields leave it.
    const report = await withTransaction(async () => {
      const inquiryGroups = await Inquiry.aggregate([
        { $match: { ...scope, ...period('createdAt') } },
        { $lookup: { from: Appointment.collection.name, let: { appointment: '$appointmentId', patient: '$patientId', branch: '$locationId' }, pipeline: [{ $match: { organizationId: orgId, $expr: { $and: [{ $eq: ['$_id', '$$appointment'] }, { $eq: ['$patientId', '$$patient'] }, { $eq: ['$locationId', '$$branch'] }] } } }, { $project: { _id: 1 } }, { $limit: 1 }], as: 'booking' } },
        { $lookup: { from: CrmActivity.collection.name, let: { inquiry: '$_id', created: '$createdAt', branch: '$locationId' }, pipeline: [{ $match: { organizationId: orgId, kind: 'call_recorded', 'communication.direction': 'outbound', $expr: { $and: [{ $eq: ['$inquiryId', '$$inquiry'] }, { $eq: ['$locationId', '$$branch'] }, { $gte: ['$communication.occurredAt', '$$created'] }, { $lte: ['$communication.occurredAt', now] }] } } }, { $sort: { 'communication.occurredAt': 1 } }, { $limit: 1 }, { $project: { minutes: { $divide: [{ $subtract: ['$communication.occurredAt', '$$created'] }, 60000] } } }], as: 'firstCall' } },
        { $group: { _id: { source: { $ifNull: ['$source', 'unknown'] }, evidence: { $ifNull: ['$sourceEvidence', 'unknown'] } }, total: { $sum: 1 }, converted: sumIf({ $and: [{ $eq: ['$status', 'converted'] }, { $eq: [{ $size: '$booking' }, 1] }] }), unreconciled: sumIf({ $and: [{ $eq: ['$status', 'converted'] }, { $eq: [{ $size: '$booking' }, 0] }] }), closed: sumIf({ $eq: ['$status', 'closed'] }), active: sumIf({ $in: ['$status', ['open', 'in_progress']] }), responseCount: sumIf({ $eq: [{ $size: '$firstCall' }, 1] }), responseMinutes: { $sum: { $ifNull: [{ $arrayElemAt: ['$firstCall.minutes', 0] }, 0] } } } },
        { $sort: { '_id.source': 1, '_id.evidence': 1 } },
      ]).option({ maxTimeMS: 8000 });
      const taskGroups = await TaskModel.aggregate([{ $match: { ...scope, kind: { $in: CRM_TASK_KINDS }, status: { $ne: 'completed' } } }, { $group: { _id: { kind: '$kind', assigned: { $cond: [{ $ifNull: ['$assignedTo', false] }, true, false] } }, total: { $sum: 1 }, overdue: sumIf({ $and: [{ $lte: ['$dueDate', now] }, { $ne: [{ $ifNull: ['$dueDate', null] }, null] }, { $lte: [{ $ifNull: ['$snoozedUntil', now] }, now] }] }), snoozed: sumIf({ $gt: ['$snoozedUntil', now] }) } }, { $sort: { '_id.kind': 1, '_id.assigned': 1 } }]).option({ maxTimeMS: 8000 });
      const workload = await TaskModel.aggregate([{ $match: { ...scope, kind: { $in: CRM_TASK_KINDS }, status: { $ne: 'completed' }, assignedTo: { $type: 'objectId' } } }, { $group: { _id: '$assignedTo', total: { $sum: 1 } } }, { $sort: { total: -1, _id: 1 } }, { $limit: 21 },
        { $lookup: { from: OrgMember.collection.name, localField: '_id', foreignField: 'userId', pipeline: [{ $match: { organizationId: orgId } }, { $limit: 1 }], as: 'member' } },
        { $lookup: { from: User.collection.name, localField: '_id', foreignField: '_id', pipeline: [{ $match: { isActive: true } }, { $project: { name: 1 } }], as: 'staff' } },
        { $project: { _id: 1, total: 1, name: { $cond: [{ $eq: [{ $size: '$member' }, 1] }, { $ifNull: [{ $arrayElemAt: ['$staff.name', 0] }, 'Unavailable owner — review assignment'] }, 'Unavailable owner — review assignment'] } } },
      ]).option({ maxTimeMS: 8000 });
      const visitGroups = await Appointment.aggregate([{ $match: { ...scope, ...period('appointmentTime') } }, { $group: { _id: '$status', total: { $sum: 1 } } }]).option({ maxTimeMS: 8000 });
      const repeatVisits = await Appointment.aggregate([
        { $match: { ...scope, ...period('appointmentTime'), status: 'completed' } },
        { $lookup: { from: Appointment.collection.name, let: { patient: '$patientId', scheduled: '$appointmentTime' }, pipeline: [{ $match: { ...scope, status: 'completed', $expr: { $and: [{ $eq: ['$patientId', '$$patient'] }, { $lt: ['$appointmentTime', '$$scheduled'] }] } } }, { $limit: 1 }, { $project: { _id: 1 } }], as: 'prior' } },
        { $group: { _id: null, completed: { $sum: 1 }, returning: sumIf({ $eq: [{ $size: '$prior' }, 1] }) } },
      ]).option({ maxTimeMS: 8000 });
      const communicationGroups = await OutboundMessage.aggregate([{ $match: { 'payload.organizationId': authority.organizationId, 'payload.patientId': { $type: 'string' }, ...period('createdAt', true) } }, { $group: { _id: { channel: '$payload.channel', status: '$status' }, total: { $sum: 1 } } }, { $sort: { '_id.channel': 1, '_id.status': 1 } }]).option({ maxTimeMS: 8000 });
      const totals = inquiryGroups.reduce((total, row) => ({ total: total.total + row.total, converted: total.converted + row.converted, unreconciled: total.unreconciled + row.unreconciled, active: total.active + row.active, closed: total.closed + row.closed, responseCount: total.responseCount + row.responseCount, responseMinutes: total.responseMinutes + row.responseMinutes }), { total: 0, converted: 0, unreconciled: 0, active: 0, closed: 0, responseCount: 0, responseMinutes: 0 });
      const visits = Object.fromEntries(visitGroups.map(row => [row._id, row.total]));
      return {
        inquiries: { ...totals, conversionPercent: rate(totals.converted, totals.total), averageFirstReportedCallMinutes: totals.responseCount ? Math.round(totals.responseMinutes / totals.responseCount) : null, sources: inquiryGroups.map(row => ({ source: row._id.source, evidence: row._id.evidence, total: row.total, converted: row.converted, conversionPercent: rate(row.converted, row.total) })) },
        tasks: { total: taskGroups.reduce((n, row) => n + row.total, 0), overdue: taskGroups.reduce((n, row) => n + row.overdue, 0), unassigned: taskGroups.filter(row => !row._id.assigned).reduce((n, row) => n + row.total, 0), snoozed: taskGroups.reduce((n, row) => n + row.snoozed, 0), kinds: taskGroups.map(row => ({ kind: row._id.kind, assigned: row._id.assigned, total: row.total, overdue: row.overdue })), workload: workload.slice(0, 20).map(row => ({ staffId: String(row._id), name: row.name, total: row.total })), workloadCapped: workload.length > 20 },
        appointments: { states: visits, total: visitGroups.reduce((n, row) => n + row.total, 0), resolvedAttendance: (visits.completed || 0) + (visits['no-show'] || 0), noShowPercent: rate(visits['no-show'] || 0, (visits.completed || 0) + (visits['no-show'] || 0)), returningCompletedVisits: repeatVisits[0]?.returning || 0, completedVisits: repeatVisits[0]?.completed || 0 },
        communications: { states: communicationGroups.map(row => ({ channel: row._id.channel || 'unknown', status: row._id.status, total: row.total })), approximateCost: null, costExplanation: 'No provider billing evidence is connected; costs are unavailable.' },
      };
    });
    return reply.send(successResponse({ asOf: now, startDate, endDate, branches: windows, ...report, definitions: {
      inquiries: 'Inquiries captured during these branch-local dates; conversion requires a matching canonical booking. Cancellation does not undo a recorded conversion.',
      response: 'First staff-reported outbound call after capture, among inquiries with such a report. Unreported calls and messages are excluded.',
      tasks: 'Current unfinished work in the selected branches. Overdue excludes tasks snoozed into the future.',
      appointments: 'Current states of visits scheduled during these dates. Attendance rate includes only completed and recorded no-show visits.',
      returning: 'Completed visits with an earlier completed visit in these authorized branches and this organization.',
      communications: 'Messages queued during these dates, grouped by their current actual delivery state. Acceptance is not delivery.',
    } }));
  } catch (error) {
    if (error instanceof CommandError) return reply.code(error.statusCode).send(errorResponse(error.message));
    req.log.error({ err: error }, 'CRM analytics unavailable'); return reply.code(503).send(errorResponse('The report could not be loaded. Retry or select a smaller range.'));
  }
}
