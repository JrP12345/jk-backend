import type { FastifyRequest, FastifyReply } from "fastify";
import crypto from "node:crypto";
import { NotificationLog } from "../models/NotificationLog.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { UsageRecord } from "../models/UsageRecord.ts";
import { Clinic } from "../models/Clinic.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Doctor } from "../models/Doctor.ts";
import { User } from "../models/User.ts";
import { appointmentService } from "../services/AppointmentService.ts";
import { whatsAppCloudApiService } from "../services/WhatsAppCloudApiService.ts";
import { getFrontendBaseUrl } from "../utilities/config.ts";
import { appendTrackerCapability, issueAppointmentTrackerLink } from "../utilities/publicTracker.ts";

interface WhatsAppBookingSession {
  step: "SELECT_DOCTOR" | "SELECT_DATE" | "CONFIRM_BOOKING";
  clinicId?: string;
  clinicName?: string;
  doctorId?: string;
  doctorName?: string;
  fee?: number;
  date?: string;
  doctorsList?: Array<{ id: string; clinicId?: string; clinicName?: string; name: string; specialization?: string; fee?: number }>;
  updatedAt: number;
}

export const bookingSessions = new Map<string, WhatsAppBookingSession>();

/**
 * Verify Meta X-Hub-Signature-256 header against the app secret.
 */
export function verifyMetaWhatsAppSignature(req: FastifyRequest, appSecret: string): boolean {
  const signatureHeader = req.headers["x-hub-signature-256"] as string | undefined;
  if (!signatureHeader) return false;

  const parts = signatureHeader.split("=");
  const signature = parts.length === 2 ? parts[1] : parts[0];

  const rawBody = (req as any).rawBody;
  const payloadString =
    typeof rawBody === "string"
      ? rawBody
      : Buffer.isBuffer(rawBody)
      ? rawBody.toString("utf8")
      : JSON.stringify(req.body);

  const expectedSignature = crypto.createHmac("sha256", appSecret).update(payloadString).digest("hex");

  try {
    if (
      signature.length === expectedSignature.length &&
      crypto.timingSafeEqual(Buffer.from(signature, "utf8"), Buffer.from(expectedSignature, "utf8"))
    ) {
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

/**
 * GET /api/webhooks/whatsapp
 * Meta Webhook verification handshake
 */
export async function verifyWhatsAppWebhook(req: FastifyRequest, reply: FastifyReply) {
  let query = (req.query as any) || {};

  // Resilient fallback: parse URL searchParams directly if req.query is empty
  if (Object.keys(query).length === 0 && req.url.includes("?")) {
    const searchParams = new URL(req.url, "http://localhost").searchParams;
    query = Object.fromEntries(searchParams.entries());
  }

  const mode = query["hub.mode"] || query?.hub?.mode;
  const token = query["hub.verify_token"] || query?.hub?.verify_token;
  const challenge = query["hub.challenge"] || query?.hub?.challenge;

  const expectedToken =
    process.env.META_WHATSAPP_VERIFY_TOKEN ||
    process.env.WHATSAPP_VERIFY_TOKEN ||
    "ananta_meta_webhook_verify_token";

  if (mode === "subscribe" && token === expectedToken) {
    return reply.code(200).send(challenge);
  }

  return reply.code(403).send({ error: "Forbidden: Invalid verify token" });
}

/**
 * POST /api/webhooks/whatsapp
 * Handles status receipts (sent, delivered, read, failed) and inbound messages (STOP opt-out)
 */
export async function handleWhatsAppWebhookEvent(req: FastifyRequest, reply: FastifyReply) {
  try {
    const secret = process.env.META_WHATSAPP_APP_SECRET || process.env.WHATSAPP_APP_SECRET;
    const isProd = process.env.NODE_ENV === "production";

    if (isProd || secret) {
      if (!secret) {
        console.error("CRITICAL: META_WHATSAPP_APP_SECRET is not configured in production environment!");
        return reply.code(401).send({ error: "Unauthorized: Webhook verification secret missing" });
      }

      const isValid = verifyMetaWhatsAppSignature(req, secret);
      if (!isValid) {
        return reply.code(401).send({ error: "Unauthorized: Invalid X-Hub-Signature-256 signature" });
      }
    }

    const body = req.body as any;

    if (body?.object !== "whatsapp_business_account") {
      return reply.code(200).send({ status: "ignored" });
    }

    const entries = body.entry || [];

  for (const entry of entries) {
    const changes = entry.changes || [];
    for (const change of changes) {
      if (change.field !== "messages") continue;
      const val = change.value;
      if (!val) continue;

      // ─────────────────────────────────────────────────────────────────────
      // 1. Delivery Status Updates
      // ─────────────────────────────────────────────────────────────────────
      if (Array.isArray(val.statuses)) {
        for (const statusObj of val.statuses) {
          const wamid = statusObj.id;
          const status = statusObj.status; // "sent", "delivered", "read", "failed"

          if (!wamid) continue;

          const log = await NotificationLog.findOne({
            $or: [{ metaMessageId: wamid }, { providerMessageId: wamid }],
          });

          if (log) {
            log.status = status;
            if (statusObj.errors && statusObj.errors.length > 0) {
              log.errorReason = JSON.stringify(statusObj.errors);
            }
            await log.save();

            // Update organization-level UsageRecord aggregates
            if (log.organizationId) {
              if (status === "delivered") {
                await UsageRecord.updateOne(
                  { organizationId: log.organizationId },
                  { $inc: { whatsappDeliveredCount: 1 } }
                ).catch(() => {});
              } else if (status === "failed") {
                await UsageRecord.updateOne(
                  { organizationId: log.organizationId },
                  { $inc: { whatsappFailedCount: 1 } }
                ).catch(() => {});
              }
            }
          }
        }
      }

      // ─────────────────────────────────────────────────────────────────────
      // 2. Inbound Messages: Opt-Out & Two-Way Interactive OPD Assistant
      // ─────────────────────────────────────────────────────────────────────
      if (Array.isArray(val.messages)) {
        for (const msg of val.messages) {
          const from = msg.from; // Phone number e.g. "919876543210"
          const rawText = msg.text?.body?.trim() || "";
          const textBody = rawText.toUpperCase();
          const digits = from.replace(/\D/g, "").slice(-10);

          if (!digits) continue;

          // Locate patient by last 10 digits
          let patient = await Patient.findOne({
            phone: { $regex: digits },
          });

          // Self-service auto-registration for new patients initiating WhatsApp chat
          if (!patient) {
            const clinic = await Clinic.findOne().lean();
            if (clinic) {
              const defaultUser = await User.create({
                name: `WhatsApp Patient (${digits.slice(-4)})`,
                phone: digits,
                role: "patient",
                isActive: true,
              });
              patient = await Patient.create({
                userId: defaultUser._id,
                name: `WhatsApp Patient (${digits.slice(-4)})`,
                phone: digits,
                organizationId: clinic.organizationId,
              });
            }
          }

          // 2A. Patient Consent Opt-Out ("STOP")
          if (textBody && ["STOP", "UNSUBSCRIBE", "OPT-OUT", "OPTOUT"].includes(textBody)) {
            if (patient) {
              patient.optOutWhatsApp = true;
              await patient.save();

              await NotificationLog.create({
                organizationId: patient.organizationId || undefined,
                recipientPhone: from,
                recipientName: patient.name || undefined,
                channel: "whatsapp",
                templateId: "OPT_OUT",
                messageContent: `Patient requested opt-out via text: ${textBody}`,
                status: "delivered",
                errorReason: "PATIENT_OPTED_OUT_WHATSAPP",
              });
            }
            continue;
          }

          // If patient is not found or has previously opted out, skip auto-responses
          if (!patient || patient.optOutWhatsApp) continue;

          const frontendUrl = getFrontendBaseUrl();
          let replyText = "";

          const activeSession = bookingSessions.get(from);

          // 2A. Cancel active session
          if (["CANCEL", "ABORT", "STOP_BOOKING"].includes(textBody)) {
            if (activeSession) {
              bookingSessions.delete(from);
              replyText = `❌ Booking session cancelled.\n\nReply *"HELP"* to see the main menu.`;
            } else {
              replyText = `No active booking session found. Reply *"HELP"* for available options.`;
            }
          }

          // 2B. Ongoing Booking State Machine Step
          else if (activeSession) {
            if (activeSession.step === "SELECT_DOCTOR") {
              const choiceIdx = parseInt(textBody, 10) - 1;
              const selectedDoc = activeSession.doctorsList && activeSession.doctorsList[choiceIdx];
              if (selectedDoc) {
                activeSession.doctorId = selectedDoc.id;
                activeSession.doctorName = selectedDoc.name;
                if (selectedDoc.clinicId) {
                  activeSession.clinicId = selectedDoc.clinicId;
                }
                if (selectedDoc.clinicName) {
                  activeSession.clinicName = selectedDoc.clinicName;
                }
                activeSession.fee = selectedDoc.fee || 500;
                activeSession.step = "SELECT_DATE";
                activeSession.updatedAt = Date.now();

                const todayStr = new Date().toISOString().slice(0, 10);
                const tomorrow = new Date();
                tomorrow.setDate(tomorrow.getDate() + 1);
                const tomorrowStr = tomorrow.toISOString().slice(0, 10);

                replyText = `📅 *Select Consultation Date*\nSelected: Dr. ${selectedDoc.name} (${selectedDoc.specialization || "General OPD"})\nFee: ₹${activeSession.fee}\n\nPlease reply with a date choice:\n1️⃣ *Today* (${todayStr})\n2️⃣ *Tomorrow* (${tomorrowStr})\nOr type a date (YYYY-MM-DD)\n\n_Reply "CANCEL" to abort._`;
              } else {
                replyText = `Please reply with a valid doctor number (e.g. 1) from the list above, or reply "CANCEL".`;
              }
            } else if (activeSession.step === "SELECT_DATE") {
              let chosenDate = "";
              if (textBody === "1" || textBody === "TODAY") {
                chosenDate = new Date().toISOString().slice(0, 10);
              } else if (textBody === "2" || textBody === "TOMORROW") {
                const tomorrow = new Date();
                tomorrow.setDate(tomorrow.getDate() + 1);
                chosenDate = tomorrow.toISOString().slice(0, 10);
              } else if (/^\d{4}-\d{2}-\d{2}$/.test(textBody)) {
                chosenDate = textBody;
              }

              if (chosenDate) {
                activeSession.date = chosenDate;
                activeSession.step = "CONFIRM_BOOKING";
                activeSession.updatedAt = Date.now();

                replyText = `📋 *Confirm Your OPD Appointment*\n\n• Patient: ${patient.name}\n• Doctor: Dr. ${activeSession.doctorName}\n• Date: ${chosenDate}\n• Clinic: ${activeSession.clinicName || "Medical Clinic"}\n• Consultation Fee: ₹${activeSession.fee} (Pay at Clinic / UPI)\n\nReply *"YES"* or *"CONFIRM"* to book your token now!`;
              } else {
                replyText = `Please reply with:\n1️⃣ *Today*\n2️⃣ *Tomorrow*\nOr type a date in YYYY-MM-DD format (or "CANCEL").`;
              }
            } else if (activeSession.step === "CONFIRM_BOOKING") {
              if (["YES", "CONFIRM", "Y", "OK", "1"].includes(textBody)) {
                try {
                  const todayDateStr = new Date().toISOString().slice(0, 10);
                  const isToday = activeSession.date === todayDateStr;
                  const appointmentTime = isToday
                    ? new Date().toISOString()
                    : new Date(`${activeSession.date}T10:00:00.000Z`).toISOString();
                  const orgIdStr = patient.organizationId ? String(patient.organizationId) : undefined;
                  const booked = await appointmentService.book(
                    { id: String(patient.userId || patient._id), role: "patient", organizationId: orgIdStr },
                    {
                      clinicId: activeSession.clinicId!,
                      doctorId: activeSession.doctorId!,
                      appointmentTime,
                      appointmentType: "walk-in",
                      patientId: patient.id,
                      notes: "Booked via WhatsApp 24/7 Self-Service Desk",
                      forceBooking: true,
                    },
                    orgIdStr
                  );

                  bookingSessions.delete(from);

                  const trackingUrl = `${frontendUrl}/track/${booked.id}${booked.trackerToken ? `?t=${encodeURIComponent(booked.trackerToken)}` : ""}`;
                  replyText = `🎉 *Appointment Confirmed!*\n\nHello ${patient.name}, your visit has been booked successfully!\n\n• Your Token: *#${booked.tokenNumber}*\n• Attending Doctor: Dr. ${activeSession.doctorName}\n• Date: ${activeSession.date}\n• Location: ${activeSession.clinicName}\n\n🔗 Live Queue Tracker:\n${trackingUrl}\n\n_Please arrive at the clinic 10 minutes before your slot. Reply "1" anytime to check live queue status!_`;
                } catch (bErr: any) {
                  bookingSessions.delete(from);
                  replyText = `⚠️ Booking could not be completed: ${bErr.message || "Please contact clinic reception directly."}`;
                }
              } else {
                bookingSessions.delete(from);
                replyText = `Booking aborted. Reply *"HELP"* for the main menu.`;
              }
            }
          }

          // 2C. Start Booking Flow: BOOK / APPOINTMENT / APPT / SCHEDULE / 4
          else if (["BOOK", "APPOINTMENT", "APPT", "SCHEDULE", "DOCTOR", "4"].includes(textBody)) {
            const orgFilter = patient.organizationId ? { organizationId: patient.organizationId } : {};

            // Find all active doctor assignments across this organization
            const assignments = await DoctorAssignment.find({ ...orgFilter, isActive: true })
              .populate("doctorId", "name")
              .populate("clinicId", "name")
              .lean();

            let availableDocs: Array<{
              id: string;
              clinicId?: string;
              clinicName?: string;
              name: string;
              specialization?: string;
              fee?: number;
            }> = [];
            let defaultClinicId: string | undefined;
            let defaultClinicName = "Medical Clinic";

            if (assignments.length > 0) {
              const docUserIds = assignments.map((a: any) => a.doctorId?._id || a.doctorId).filter(Boolean);
              const docProfiles = await Doctor.find({
                $or: [{ userId: { $in: docUserIds } }, { _id: { $in: docUserIds } }],
              }).lean();

              const profileMap = new Map<string, any>();
              docProfiles.forEach((p) => {
                if (p.userId) profileMap.set(p.userId.toString(), p);
                profileMap.set(p._id.toString(), p);
              });

              for (const a of assignments) {
                if (!a.doctorId) continue;
                const docUser = a.doctorId as any;
                const uId = docUser._id ? docUser._id.toString() : a.doctorId.toString();
                const clinicObj = a.clinicId as any;
                const cId = clinicObj?._id ? clinicObj._id.toString() : a.clinicId?.toString();
                const cName = clinicObj?.name || defaultClinicName;
                const profile = profileMap.get(uId);

                if (!defaultClinicId && cId) {
                  defaultClinicId = cId;
                  defaultClinicName = cName;
                }

                availableDocs.push({
                  id: uId,
                  clinicId: cId,
                  clinicName: cName,
                  name: docUser.name || profile?.name || "Physician",
                  specialization: profile?.specialization || "General Medicine",
                  fee: a.fees || 500,
                });
              }
            }

            // Fallback: If no assignments found, find clinics in the org
            if (availableDocs.length === 0) {
              const clinic = await Clinic.findOne(orgFilter).lean();
              if (clinic) {
                defaultClinicId = clinic._id.toString();
                defaultClinicName = clinic.name;
                const docUsers = await User.find({ role: "doctor", isActive: true }).limit(3).lean();
                for (const du of docUsers) {
                  availableDocs.push({
                    id: du._id.toString(),
                    clinicId: defaultClinicId,
                    clinicName: defaultClinicName,
                    name: du.name,
                    specialization: (du as any).specialization || "General OPD",
                    fee: 500,
                  });
                }
              }
            }

            if (!defaultClinicId) {
              replyText = `Hello ${patient.name}, no active clinic found for your account. Please visit: ${frontendUrl}`;
            } else if (availableDocs.length > 0) {
              bookingSessions.set(from, {
                step: "SELECT_DOCTOR",
                clinicId: defaultClinicId,
                clinicName: defaultClinicName,
                doctorsList: availableDocs,
                updatedAt: Date.now(),
              });

              const docListText = availableDocs
                .map((d, i) => `${i + 1}️⃣ Dr. ${d.name} (${d.specialization}) — ₹${d.fee}`)
                .join("\n");

              replyText = `🩺 *Schedule an OPD Appointment*\n\nPlease reply with the doctor's number:\n${docListText}\n\n_Reply "CANCEL" to exit._`;
            } else {
              replyText = `Hello ${patient.name}, no doctors are currently available for online booking today. Please visit reception directly.`;
            }
          }

          // 2D. Interactive Keyword: STATUS / TOKEN / QUEUE / 1
          else if (["STATUS", "TOKEN", "QUEUE", "WAIT", "1"].includes(textBody)) {
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);
            const todayEnd = new Date();
            todayEnd.setHours(23, 59, 59, 999);

            const activeAppt = await Appointment.findOne({
              patientId: patient._id,
              appointmentTime: { $gte: todayStart, $lte: todayEnd },
              status: { $in: ["pending", "confirmed", "checked-in", "in-consultation", "standby"] },
            }).populate("clinicId doctorId").sort({ appointmentTime: -1 });

            if (activeAppt) {
              const docName = (activeAppt.doctorId as any)?.name || "Doctor";
              const clinicName = (activeAppt.clinicId as any)?.name || "Clinic";

              if (activeAppt.status === "in-consultation") {
                replyText = `🩺 *Hello ${patient.name}!*\n\nIt is currently your turn! Dr. ${docName} is waiting for you in the consultation room for *Token #${activeAppt.tokenNumber}* at ${clinicName}.\n\nPlease step inside immediately.`;
              } else {
                const inConsult = await Appointment.findOne({
                  clinicId: activeAppt.clinicId,
                  doctorId: activeAppt.doctorId,
                  status: "in-consultation",
                });
                const aheadCount = await Appointment.countDocuments({
                  clinicId: activeAppt.clinicId,
                  doctorId: activeAppt.doctorId,
                  status: "checked-in",
                  queuePosition: { $lt: activeAppt.queuePosition || 999 },
                });
                const estWait = Math.max(0, aheadCount * 12);

                const { url } = await issueAppointmentTrackerLink(activeAppt as any);
                const trackingUrl = `${frontendUrl}${url}`;
                replyText = `🎫 *Live OPD Queue Status*\n\nHello ${patient.name},\n• Your Token: *#${activeAppt.tokenNumber}*\n• Currently in Cabin: *Token #${inConsult?.tokenNumber || "None"}*\n• Patients Ahead: *${aheadCount}*\n• Est. Wait Time: *~${estWait} mins*\n• Status: *${activeAppt.status.toUpperCase()}*\n\n📍 ${clinicName} (Dr. ${docName})\n\n🔗 Live Queue Tracker:\n${trackingUrl}\n\n_Reply "3" if you are running late and need to postpone._`;
              }
            } else {
              const completedToday = await Appointment.findOne({
                patientId: patient._id,
                appointmentTime: { $gte: todayStart, $lte: todayEnd },
                status: "completed",
              }).sort({ updatedAt: -1 });

              if (completedToday) {
                replyText = `✅ *Consultation Complete*\n\nHello ${patient.name}, your visit today for Token #${completedToday.tokenNumber} has been concluded.\n\nReply *"2"* or *"RX"* to retrieve your prescription summary and printable PDF.`;
              } else {
                replyText = `Hello ${patient.name}, no active OPD appointment found for today.\n\nReply *"4"* or *"BOOK"* to schedule a new consultation with a doctor!`;
              }
            }
          }

          // 2E. Interactive Keyword: RX / PRESCRIPTION / MEDS / PDF / 2
          else if (["RX", "PRESCRIPTION", "MEDS", "MEDICINES", "PDF", "2"].includes(textBody)) {
            const latestCompleted = await Appointment.findOne({
              patientId: patient._id,
              status: "completed",
              "prescriptions.0": { $exists: true },
            }).populate("doctorId clinicId").sort({ updatedAt: -1 });

            if (latestCompleted && latestCompleted.prescriptions && latestCompleted.prescriptions.length > 0) {
              const docName = (latestCompleted.doctorId as any)?.name || "Attending Physician";
              const medList = latestCompleted.prescriptions.map((p, idx) => `  ${idx + 1}. *${p.name}* — ${p.dosage} (${p.duration})`).join("\n");

              const { token: trackerToken, url } = await issueAppointmentTrackerLink(latestCompleted as any);
              const trackingUrl = `${frontendUrl}${url}`;
              const prescriptionUrl = appendTrackerCapability(`/api/public/track/${latestCompleted._id}/prescription/print`, trackerToken);
              replyText = `📋 *Digital Prescription (Rx)*\nDoctor: Dr. ${docName}\nDiagnosis: ${latestCompleted.diagnosis || "General Outpatient Consultation"}\nDate: ${new Date(latestCompleted.appointmentTime).toLocaleDateString("en-IN")}\n\n*Prescribed Medicines:*\n${medList}\n\n${latestCompleted.followUpNotes ? `*Advice:* ${latestCompleted.followUpNotes}\n\n` : ""}📄 Download Official Rx: ${trackingUrl}\n\n_Your PDF document attachment is arriving below..._`;

              // Dispatch official PDF document directly into WhatsApp chat
              const cleanDoc = docName.replace(/[^a-zA-Z0-9]/g, "_");
              whatsAppCloudApiService.sendDocumentMessage({
                to: from,
                documentUrl: prescriptionUrl,
                filename: `Prescription_Token_${latestCompleted.tokenNumber}_Dr_${cleanDoc}.pdf`,
                caption: `📄 Official Signed Prescription from Dr. ${docName} (Token #${latestCompleted.tokenNumber})`,
              }).catch((err) => console.error("WhatsApp document reply failed:", err));
            } else {
              replyText = `Hello ${patient.name}, no completed digital prescription found for your registered profile.`;
            }
          }

          // 2E2. Interactive Keyword: BILL / INVOICE / RECEIPT / 5
          else if (["BILL", "INVOICE", "RECEIPT", "PAYMENT", "5"].includes(textBody)) {
            const latestAppt = await Appointment.findOne({
              patientId: patient._id,
              paymentStatus: { $in: ["paid", "pay_at_clinic", "pending"] },
            }).populate("doctorId clinicId").sort({ updatedAt: -1 });

            if (latestAppt) {
              const clinicName = (latestAppt.clinicId as any)?.name || "Clinic";
              const fee = latestAppt.paymentAmount || 500;
              const isPaid = latestAppt.paymentStatus === "paid";

              const { token: trackerToken, url } = await issueAppointmentTrackerLink(latestAppt as any);
              const trackingUrl = `${frontendUrl}${url}`;
              const prescriptionUrl = appendTrackerCapability(`/api/public/track/${latestAppt._id}/prescription/print`, trackerToken);
              replyText = `🧾 *OPD Invoice Summary*\n\n• Patient: ${patient.name}\n• Facility: ${clinicName}\n• Token: #${latestAppt.tokenNumber}\n• Amount: ₹${fee}\n• Payment Status: *${isPaid ? "PAID ✅" : "PENDING ⏳"}*\n\n🔗 View & Pay Online:\n${trackingUrl}`;

              if (isPaid) {
                whatsAppCloudApiService.sendDocumentMessage({
                  to: from,
                  documentUrl: prescriptionUrl,
                  filename: `Invoice_Receipt_Token_${latestAppt.tokenNumber}.pdf`,
                  caption: `🧾 Official Paid Receipt - Token #${latestAppt.tokenNumber} (₹${fee})`,
                }).catch((err) => console.error("WhatsApp invoice document reply failed:", err));
              }
            } else {
              replyText = `Hello ${patient.name}, no recent billing records found.`;
            }
          }

          // 2F. Interactive Keyword: DELAY / LATE / BUMP / 3
          else if (["DELAY", "LATE", "BUMP", "POSTPONE", "3"].includes(textBody)) {
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);
            const todayEnd = new Date();
            todayEnd.setHours(23, 59, 59, 999);

            const activeAppt = await Appointment.findOne({
              patientId: patient._id,
              appointmentTime: { $gte: todayStart, $lte: todayEnd },
              status: { $in: ["pending", "confirmed", "checked-in"] },
            }).sort({ appointmentTime: -1 });

            if (activeAppt) {
              activeAppt.queuePosition = (activeAppt.queuePosition || 1) + 2;
              activeAppt.parkedReason = "Patient requested arrival postponement via WhatsApp self-service";
              await activeAppt.save();

              const { url } = await issueAppointmentTrackerLink(activeAppt as any);
              replyText = `⏳ *Token Postponed Successfully*\n\nHello ${patient.name}, your Token *#${activeAppt.tokenNumber}* has been moved back 2 positions to give you extra arrival time.\n\nNew Queue Sequence: Position #${activeAppt.queuePosition}\n\n🔗 Live Tracker: ${frontendUrl}${url}`;
            } else {
              replyText = `Hello ${patient.name}, you do not have an active waiting queue token today to postpone.`;
            }
          }

          // 2G. Default Help Menu
          else {
            replyText = `👋 *ANANT Healthcare OPD Assistant*\n\nHello ${patient.name}, how can we help you today?\n\nReply with a number:\n1️⃣ *STATUS* - Check live token & queue wait time\n2️⃣ *RX* - View & receive PDF prescription\n3️⃣ *DELAY* - Running late? Postpone token by 2 turns\n4️⃣ *BOOK* - Schedule an appointment with a doctor\n5️⃣ *BILL* - View receipt & payment details\n\n_Reply "STOP" at any time to opt out._`;
          }

          // Dispatch conversational response to patient's WhatsApp
          if (replyText) {
            await whatsAppCloudApiService.sendFreeformTextMessage({
              to: from,
              text: replyText,
            });

            await NotificationLog.create({
              organizationId: patient.organizationId || undefined,
              recipientPhone: from,
              recipientName: patient.name || undefined,
              channel: "whatsapp",
              templateId: "TWO_WAY_ASSISTANT",
              messageContent: replyText,
              status: "sent",
            }).catch(() => {});
          }
        }
      }
    }
  }

  // Meta expects an immediate 200 OK response
  return reply.code(200).send({ success: true, status: "ok" });
} catch (err: any) {
  console.error("handleWhatsAppWebhookEvent error:", err);
  return reply.code(200).send({ success: false, error: err?.message || "Webhook processing error" });
}
}
