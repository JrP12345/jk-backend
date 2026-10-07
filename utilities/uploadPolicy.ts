import type { FastifyRequest } from 'fastify';
import type { ContentClass } from '../models/UploadIntent.ts';
import { Patient } from '../models/Patient.ts';
import mongoose from 'mongoose';
import { checkPatientAccess } from './tenant.ts';
import { requestHasAnyPermission } from './permissions.ts';
import { detectMagicBytes, scanForActiveMaliciousContent } from './fileSecurity.ts';
import { UploadIntent } from '../models/UploadIntent.ts';

export const CLASS_MAX_BYTES: Record<ContentClass, number> = {
  avatar: 2 * 1024 * 1024, prescription: 10 * 1024 * 1024,
  clinical_document: 25 * 1024 * 1024, lab_report: 25 * 1024 * 1024,
  radiology: 50 * 1024 * 1024, other: 10 * 1024 * 1024,
};
const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'application/dicom', 'text/plain', 'text/csv']);
export const normalizeUploadMime = (value: string) => value.trim().toLowerCase().replace(/^image\/jpg$/, 'image/jpeg');
export function validateUploadMetadata(filename: unknown, mime: unknown, contentClass: unknown): string | null {
  if (typeof filename !== 'string' || !filename.trim() || filename.length > 255 || /[\x00-\x1f/\\:]/.test(filename)) return 'Invalid originalFilename';
  if (typeof mime !== 'string' || !allowed.has(normalizeUploadMime(mime))) return 'Unsupported content type';
  if (typeof contentClass !== 'string' || !Object.hasOwn(CLASS_MAX_BYTES, contentClass)) return 'Invalid contentClass';
  if (contentClass === 'avatar' && !normalizeUploadMime(mime).startsWith('image/')) return 'Avatar must be an image';
  return null;
}
export function validateUploadBytes(buffer: Buffer, declaredMime: string, maxBytes: number) {
  if (!buffer.length || buffer.length > maxBytes) throw new Error('File is empty or exceeds the allowed size');
  const detected = detectMagicBytes(buffer);
  const mime = normalizeUploadMime(declaredMime);
  if (!detected || (detected !== mime && !(mime === 'text/csv' && detected === 'text/plain'))) throw new Error('File signature does not match its declared content type');
  const scan = scanForActiveMaliciousContent(buffer);
  if (!scan.clean) throw new Error('File contains unsupported active content');
  return mime;
}

/** New clinical attachments reuse verified upload authority instead of embedding arbitrary URLs/bytes. */
export async function isVerifiedClinicalAttachment(value: unknown, organizationId: unknown, patientId: unknown) {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value !== 'string' || !organizationId || !patientId ||
      !value.startsWith(`tenants/${organizationId}/verified/`)) return false;
  return !!await UploadIntent.exists({ objectKey: value, organizationId, patientId,
    status: 'completed', magicBytesVerified: true, malwareClean: true });
}
export async function authorizeUpload(req: FastifyRequest, patientId?: unknown, write = true) {
  const consumer = ['patient', 'family_member'].includes(req.user?.role || '');
  if (req.user?.role === 'guest') return { allowed: false, statusCode: 403, message: 'Guest uploads are not permitted' };
  if (!consumer && !await requestHasAnyPermission(req, ...(write ? ['MANAGE_EHR', 'MANAGE_PATIENTS', 'MANAGE_ORDERS', 'MANAGE_STAFF', 'MANAGE_LOCATIONS'] : ['VIEW_EHR']))) {
    return { allowed: false, statusCode: 403, message: 'File permission is required' };
  }
  if (patientId) {
    const check = await checkPatientAccess(req, patientId);
    if (check.allowed && req.user?.role === 'root' && typeof patientId === 'string' && mongoose.Types.ObjectId.isValid(patientId)) {
      const patient = await Patient.findById(patientId).select('organizationId').lean();
      return { allowed: !!patient?.organizationId, statusCode: 404, message: 'Patient not found', organizationId: patient?.organizationId?.toString() };
    }
    return check;
  }
  if (consumer) return { allowed: false, statusCode: 400, message: 'Patient context is required' };
  return { allowed: !!req.user?.organization_id, statusCode: 400, message: 'Organization context is required', organizationId: req.user?.organization_id };
}
