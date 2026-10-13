import { getNextAtomicSequence } from '../models/Counter.ts';
import { OrgMember } from '../models/OrgMember.ts';
import { CommandError } from './CommandReceiptService.ts';
// Membership removal, role change and account suspension serialize the same
// last-administrator check. Call inside the command's transaction.
export async function assertOtherActiveAdministrator(organizationId: string, excludedUserId: string) {
  try { await getNextAtomicSequence(`organization-governance:${organizationId}`); }
  catch (error: any) { if (error.code === 11000) throw new CommandError(409, 'Organization administration changed; retry after refreshing'); throw error; }
  const others = await OrgMember.find({ organizationId, role: 'admin', userId: { $ne: excludedUserId } }).populate('userId', 'isActive').lean();
  if (!others.some((member: any) => member.userId && member.userId.isActive !== false)) throw new CommandError(409, 'Keep at least one active organization administrator');
}
