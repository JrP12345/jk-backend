import { safeError } from "../utilities/safeError.ts";
import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Medicine } from "../models/Medicine.ts";
import { Patient } from "../models/Patient.ts";
import { Invoice } from "../models/Invoice.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { Prescription } from "../models/Prescription.ts";
import { Appointment } from "../models/Appointment.ts";
import { successResponse, errorResponse, escapeRegex, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";
import { checkLocationAccess, checkOperationalRecordAccess, getRequestLocationIds } from "../utilities/tenant.ts";
import { withTransaction, createWithSession } from "../utilities/transaction.ts";
import { dispenseMedicineFEFO, PharmacyInventoryError } from "../services/PharmacyInventoryService.ts";
import { allocateInvoiceNumber } from "../utilities/invoiceNumber.ts";
import { loadPharmacyIssuer, pricePharmacySupply, pharmacyDocumentSnapshot } from "../services/PharmacyDocumentService.ts";
import { pharmacyRequestAllows } from "../services/PharmacyCapabilityService.ts";
import { pinActivePharmacyLocation } from "../utilities/pharmacyCapability.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { adjustMedicineStock, type StockAdjustmentInput } from "../services/PharmacyStockMovementService.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { executePharmacyDispense, getDispenseOperation, type PharmacyDispenseInput } from "../services/PharmacyOperationService.ts";
import { mutationKey } from "../services/IdempotentMutationService.ts";
import { requireStockTransaction } from "../utilities/pharmacyInventory.ts";
import { finalizedPrescriptionSelection } from "../services/FinalizedPrescriptionSelection.ts";
import { PharmacyDispense } from "../models/PharmacyDispense.ts";
import { authorizePrescriptionDispense, fulfillAuthorizedPrescriptions } from "../services/PrescriptionDispenseAuthority.ts";
import { prescriptionQuantityState, type PrescriptionQuantityState } from "../services/PrescriptionQuantityService.ts";
import { requireKnownClinicalCharges } from "../services/PharmacyChargeSource.ts";
import { catalogueFields, normalizeUnitDefinition } from "../utilities/medicineCatalogue.ts";

function sendTenantError(reply: FastifyReply, check: { allowed: false; statusCode: number; message: string }) {
  return reply.code(check.statusCode).send(errorResponse(check.message));
}

// ─── Medicine CRUD Handlers ─────────────────────────────────────

export async function createMedicine(req: FastifyRequest, reply: FastifyReply) {
  try {
    const {
      locationId, name, genericName, stockQuantity = 0, price, costPrice,
      expiryDate, batchNumber, scheduleType, unitDefinition, hsnCode, gstRate
    } = req.body as any;

    if (!locationId || !name || !genericName || price === undefined) {
      return reply.code(400).send(errorResponse("locationId, name, genericName and price are required"));
    }

    if (!mongoose.Types.ObjectId.isValid(locationId)) {
      return reply.code(400).send(errorResponse("Invalid location ID"));
    }
    const locationAccess = await checkLocationAccess(req, locationId);
    if (!locationAccess.allowed) return sendTenantError(reply, locationAccess);
    if (!Number.isSafeInteger(stockQuantity) || stockQuantity < 0 || !Number.isFinite(price) || price < 0 || costPrice !== undefined && (!Number.isFinite(costPrice) || costPrice < 0)) {
      return reply.code(400).send(errorResponse("Stock and prices must be non-negative numbers; stock must be a safe integer"));
    }
    const metadata = catalogueFields(req.body as Record<string, unknown>);
    const opening = stockQuantity > 0 || expiryDate !== undefined || batchNumber !== undefined;
    const canViewCost = await pharmacyRequestAllows(req, "viewCost");
    if (opening && (!await pharmacyRequestAllows(req, "receiveStock") || !canViewCost)) return reply.code(403).send(errorResponse("Opening-stock creation requires stock receipt and cost permissions"));
    if (costPrice !== undefined && !canViewCost) return reply.code(403).send(errorResponse("Acquisition cost permission is required to set cost fields"));
    if (opening && (!expiryDate || !batchNumber?.trim() || costPrice === undefined)) return reply.code(400).send(errorResponse("Legacy opening stock requires an actual batch, expiry and acquisition cost"));
    const parsedExpiryDate = expiryDate !== undefined ? new Date(expiryDate) : undefined;
    if (parsedExpiryDate && Number.isNaN(parsedExpiryDate.getTime())) {
      return reply.code(400).send(errorResponse("Invalid expiry date"));
    }
    if (unitDefinition && stockQuantity > 0) throw new CommandError(409, "Configure units on an empty catalogue item, then receive stock in base units");

    const medicine = await withTransaction(async session => {
      await pinActivePharmacyLocation(locationId, session);
      return Medicine.create({
      locationId,
      ...metadata,
      stockQuantity,
      price,
      ...(costPrice !== undefined ? { costPrice } : {}),
      ...(parsedExpiryDate ? { expiryDate: parsedExpiryDate } : {}),
      ...(batchNumber ? { batchNumber: batchNumber.trim() } : {}),
      ...(unitDefinition ? { unitDefinition: normalizeUnitDefinition(unitDefinition, 1) } : {}),
      ...(hsnCode !== undefined ? { hsnCode } : {}), ...(gstRate !== undefined ? { gstRate } : {}),
      scheduleType: scheduleType || "general",
      });
    });

    return reply.code(201).send(successResponse(medicine, "Medicine registered successfully"));
  } catch (err) {
    if (err instanceof CommandError) return reply.code(err.statusCode).send(errorResponse(err.message));
    if ((err as { code?: number }).code === 11000) return reply.code(409).send(errorResponse("A barcode is already assigned to an active medicine at this location"));
    if (err instanceof mongoose.Error.ValidationError) return reply.code(400).send(errorResponse("Invalid medicine fields"));
    console.error("createMedicine error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getMedicines(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { locationId, search, barcode, medicineIds, stockFilter, page, limit } = req.query as { locationId?: string; search?: string; barcode?: string; medicineIds?: string; stockFilter?: string; page?: string | number; limit?: string | number };

    const query: any = { deletedAt: null };
    if (locationId) {
      if (!mongoose.Types.ObjectId.isValid(locationId)) {
        return reply.code(400).send(errorResponse("Invalid location ID"));
      }
      const locationAccess = await checkLocationAccess(req, locationId);
      if (!locationAccess.allowed) return sendTenantError(reply, locationAccess);
      query.locationId = locationId;
    } else {
      const locationIds = await getRequestLocationIds(req);
      if (locationIds) query.locationId = { $in: locationIds };
    }

    if (barcode) query.barcodes = barcode.trim();
    if (medicineIds) query._id = { $in: medicineIds.split(",") };
    if (search?.trim()) {
      const safeSearch = escapeRegex(search.trim());
      query.$or = [
        { name: { $regex: safeSearch, $options: "i" } },
        { genericName: { $regex: safeSearch, $options: "i" } },
        { strength: { $regex: safeSearch, $options: "i" } },
        { manufacturer: { $regex: safeSearch, $options: "i" } },
        { batchNumber: { $regex: safeSearch, $options: "i" } },
        { barcodes: search.trim() },
      ];
    }
    if (stockFilter === "low") query.$expr = { $lte: ["$stockQuantity", { $ifNull: ["$reorderLevel", 20] }] };
    if (stockFilter === "out") query.stockQuantity = 0;
    if (stockFilter === "expired") query.expiryDate = { $lte: new Date() };

    const totalCount = await Medicine.countDocuments(query);
    const { page: currentPage, limit: pageSize, skip } = getPaginationParams({ page, limit });
    const totalPages = Math.ceil(totalCount / pageSize);

    const canManage = await pharmacyRequestAllows(req, "viewCost");
    const medicines = await Medicine.find(query)
      .select(canManage ? "" : "-costPrice")
      .sort({ name: 1, _id: 1 })
      .skip(skip)
      .limit(pageSize);

    setPaginationHeaders(reply, { totalCount, totalPages, currentPage, pageSize });
    return reply.code(200).send(successResponse(medicines));
  } catch (err) {
    console.error("getMedicines error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function updateMedicine(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid medicine ID"));
    }

    const { stockQuantity, price, costPrice, expiryDate, batchNumber, scheduleType } = req.body as any;
    const metadata = catalogueFields(req.body as Record<string, unknown>);

    if (stockQuantity !== undefined && (!Number.isSafeInteger(stockQuantity) || stockQuantity < 0)) {
      return reply.code(400).send(errorResponse("stockQuantity must be a non-negative safe integer"));
    }
    if ([price, costPrice].some(value => value !== undefined && (!Number.isFinite(value) || value < 0))) {
      return reply.code(400).send(errorResponse("Prices must be finite non-negative numbers"));
    }
    if (expiryDate !== undefined && (typeof expiryDate !== "string" || !expiryDate.trim() || Number.isNaN(new Date(expiryDate).getTime()))) {
      return reply.code(400).send(errorResponse("Invalid expiry date"));
    }

    const medicine: any = await Medicine.findOne({ _id: id, deletedAt: null });
    if (!medicine) {
      return reply.code(404).send(errorResponse("Medicine not found"));
    }
    const medicineAccess = await checkOperationalRecordAccess(req, medicine);
    if (!medicineAccess.allowed) return sendTenantError(reply, medicineAccess);

    const canViewCost = await pharmacyRequestAllows(req, "viewCost");
    if (costPrice !== undefined && !canViewCost) return reply.code(403).send(errorResponse("Acquisition cost permission is required to change cost fields"));

    const updated = await withTransaction(async session => {
      // An unrelated metadata save must not persist a hydrated default as a legacy sale classification.
      const storedCategory = await Medicine.findOne({ _id: id, deletedAt: null }).select("scheduleType").lean().session(session);
      if (storedCategory && !["general", "schedule_h", "schedule_h1", "schedule_x", "narcotic"].includes(storedCategory.scheduleType || "")) {
        throw new PharmacyInventoryError("Review the missing sale classification through the dispensing-classification endpoint before editing this medicine", 409);
      }
      const current = await Medicine.findOne({ _id: id, deletedAt: null }).session(session);
      if (!current) throw new PharmacyInventoryError("Medicine not found", 404);
      // Quantity edits use the count/revision command; an unchanged field keeps
      // existing metadata forms compatible without overwriting current stock.
      if (stockQuantity !== undefined && stockQuantity !== current.stockQuantity) {
        throw new PharmacyInventoryError("Use the stock adjustment workflow with an expected quantity and revision");
      }
      const input = req.body as { unitDefinition?: unknown; expectedUnitVersion?: number; hsnCode?: string; gstRate?: number };
      if (input.hsnCode !== undefined && input.hsnCode !== current.hsnCode || input.gstRate !== undefined && input.gstRate !== current.gstRate) throw new CommandError(409, "Use the reviewed tax-classification endpoint to change HSN or tax rates");
      if (input.unitDefinition !== undefined) {
        const version = current.unitDefinition?.version ?? 0;
        if (input.expectedUnitVersion !== version) throw new CommandError(409, "Unit definition changed; reload before editing units");
        const next = normalizeUnitDefinition(input.unitDefinition, version + 1);
        const differs = !current.unitDefinition || (["baseUnit", "packUnit", "unitsPerPack"] as const).some(key => next[key] !== current.unitDefinition?.[key]);
        if (differs) {
          if (current.stockQuantity !== 0 || await MedicineBatch.exists({ medicineId: current._id }).session(session)) throw new CommandError(409, "Existing stock or batch history needs reviewed unit reconciliation; units cannot be reinterpreted here");
          current.set("unitDefinition", next);
        }
      }
      current.set(metadata);
      if (price !== undefined) current.price = price;
      if (costPrice !== undefined) current.costPrice = costPrice;
      if (expiryDate !== undefined) current.expiryDate = new Date(expiryDate);
      if (batchNumber !== undefined) current.batchNumber = batchNumber;
      if (scheduleType !== undefined && scheduleType !== current.scheduleType) {
        throw new PharmacyInventoryError("Use the reviewed dispensing-classification endpoint to change sale restrictions", 409);
      }
      await current.save(session ? { session } : undefined);
      await pinActivePharmacyLocation(String(medicine.locationId), session);
      return current;
    });
    const result: Record<string, unknown> = updated.toJSON();
    if (!canViewCost) delete result.costPrice;
    return reply.code(200).send(successResponse(result, "Medicine updated successfully"));
  } catch (err) {
    if (err instanceof PharmacyInventoryError || err instanceof CommandError) return reply.code(err.statusCode).send(errorResponse(err.message));
    if (err instanceof mongoose.Error.ValidationError) return reply.code(400).send(errorResponse("Invalid medicine fields"));
    if ((err as { code?: number }).code === 11000) return reply.code(409).send(errorResponse("A barcode is already assigned to an active medicine at this location"));
    console.error("updateMedicine error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function deleteMedicine(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid medicine ID"));
    }

    const medicine = await Medicine.findOne({ _id: id, deletedAt: null });
    if (!medicine) {
      return reply.code(404).send(errorResponse("Medicine not found"));
    }
    const medicineAccess = await checkOperationalRecordAccess(req, medicine);
    if (!medicineAccess.allowed) return sendTenantError(reply, medicineAccess);

    await withTransaction(async session => {
      await pinActivePharmacyLocation(String(medicine.locationId), session);
      if (!await Medicine.findOneAndUpdate({ _id: id, locationId: medicine.locationId, deletedAt: null }, { $set: { deletedAt: new Date() } }, { returnDocument: "after" })) {
        throw new CommandError(409, "Medicine changed; reload before deleting");
      }
    });

    return reply.code(200).send(successResponse(null, "Medicine deleted successfully"));
  } catch (err) {
    if (err instanceof CommandError) return reply.code(err.statusCode).send(errorResponse(err.message));
    console.error("deleteMedicine error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Pending Prescriptions (Pharmacy Dispensing Desk) ─────────────

export async function getPendingPrescriptionsController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { locationId } = req.query as { locationId?: string };

    if (!locationId || !mongoose.Types.ObjectId.isValid(locationId)) {
      return reply.code(400).send(errorResponse("Valid locationId is required"));
    }

    const locationAccess = await checkLocationAccess(req, locationId);
    if (!locationAccess.allowed) return sendTenantError(reply, locationAccess);

    const prescriptions = await Prescription.find({
      ...await finalizedPrescriptionSelection({ organizationId: locationAccess.organizationId, locationId }),
      status: "active",
      deletedAt: null,
    })
      .populate({
        path: "patientId",
        select: "name phone userId",
        populate: { path: "userId", select: "name phone email" },
      })
      .populate("doctorId", "name email phone")
      .populate("encounterId", "appointmentId startedAt endedAt")
      .sort({ createdAt: -1 })
      .lean();

    const grouped = new Map<string, {
      encounterId: string;
      appointmentId: string | null;
      appointmentTime: string | null;
      tokenNumber?: number | null;
      patientId: { id: string; name: string; phone?: string };
      doctorId: { id: string; name: string };
      prescriptions: Array<{
        id: string;
        medicineId: string | null;
        name: string;
        dosage: string;
        frequency: string;
        duration: string;
        instructions: string;
        fulfillment: PrescriptionQuantityState;
      }>;
    }>();

    // Batch fetch appointments for all encounters to avoid N+1 queries
    const apptIds = Array.from(new Set(
      prescriptions
        .map((rx: any) => rx.encounterId?.appointmentId)
        .filter(Boolean)
        .map((id: any) => String(id))
    ));

    const appointmentsMap = new Map<string, any>();
    if (apptIds.length > 0) {
      const appts = await Appointment.find({ _id: { $in: apptIds } }).select("appointmentTime tokenNumber status").lean();
      for (const appt of appts) {
        appointmentsMap.set(String(appt._id), appt);
      }
    }

    for (const rx of prescriptions) {
      const encounterId = String((rx as any).encounterId?._id || rx.encounterId);
      if (!grouped.has(encounterId)) {
        const patientDoc = (rx as any).patientId;
        const doctorDoc = (rx as any).doctorId;
        const encounterDoc = (rx as any).encounterId;

        let appointmentTime: string | null = null;
        let appointmentId: string | null = null;
        let tokenNumber: number | null = null;
        if (encounterDoc?.appointmentId) {
          appointmentId = String(encounterDoc.appointmentId);
          const appt = appointmentsMap.get(appointmentId);
          appointmentTime = appt?.appointmentTime ? new Date(appt.appointmentTime).toISOString() : null;
          tokenNumber = appt?.tokenNumber || null;
        } else if (encounterDoc?.startedAt) {
          appointmentTime = new Date(encounterDoc.startedAt).toISOString();
        }

        grouped.set(encounterId, {
          encounterId,
          appointmentId,
          appointmentTime,
          tokenNumber,
          patientId: {
            id: String(patientDoc?._id || rx.patientId),
            name: patientDoc?.name || patientDoc?.userId?.name || "Patient",
            phone: patientDoc?.phone || patientDoc?.userId?.phone,
          },
          doctorId: {
            id: String(doctorDoc?._id || rx.doctorId),
            name: doctorDoc?.name || "Doctor",
          },
          prescriptions: [],
        });
      }

      grouped.get(encounterId)!.prescriptions.push({
        id: String((rx as any)._id),
        medicineId: (rx as any).medicineId ? String((rx as any).medicineId) : null,
        name: (rx as any).medicineName,
        dosage: (rx as any).dosage,
        frequency: (rx as any).frequency || "1-0-1",
        duration: (rx as any).duration,
        instructions: (rx as any).instructions || "",
        fulfillment: prescriptionQuantityState(rx),
      });
    }

    return reply.code(200).send(successResponse(Array.from(grouped.values())));
  } catch (err) {
    console.error("getPendingPrescriptionsController error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Dispensing Prescriptions Handler ─────────────────────────────

export async function dispensePrescription(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const input = req.body as PharmacyDispenseInput;
    const locationAccess = await checkLocationAccess(req, input.locationId);
    if (!locationAccess.allowed) return sendTenantError(reply, locationAccess);
    const key = mutationKey(req);
    const authority = { organizationId: locationAccess.organizationId!, locationId: input.locationId.toLowerCase(), actorId: req.user!.id };
    const result = await executePharmacyDispense(authority, key, input, normalized => withTransaction(async session => {
      requireStockTransaction(session);
      const currentAccess = await checkLocationAccess(req, normalized.locationId);
      if (!currentAccess.allowed) throw new CommandError(currentAccess.statusCode, currentAccess.message);
      if (currentAccess.organizationId !== authority.organizationId) throw new CommandError(404, "Location not found");
      const userId = req.user!.id;
      const { patientId, locationId, items, prescriptionIds } = normalized;
      const source = await authorizePrescriptionDispense(authority, normalized);
      const resolvedEncounterId = source.encounterId;
      const resolvedAppointmentId = source.appointmentId;
      const invoiceDoctorId = source.doctorId;
      const visitInvoices = await Invoice.find({ organizationId: authority.organizationId, locationId, patientId, deletedAt: null,
        $or: [{ encounterId: resolvedEncounterId }, ...(resolvedAppointmentId ? [{ appointmentId: resolvedAppointmentId }] : [])],
      }).sort({ createdAt: 1 });
      for (const invoice of visitInvoices) requireKnownClinicalCharges(invoice);
      const issuer = await loadPharmacyIssuer(authority.organizationId, locationId);
      const parentInvoice = visitInvoices.find(invoice => invoice.documentVersion !== 1 && !invoice.supplementForInvoiceId)
        || visitInvoices.find(invoice => !invoice.supplementForInvoiceId);
      const dispenseId = new mongoose.Types.ObjectId();
      const invoiceId = new mongoose.Types.ObjectId();
      const issuedAt = new Date();
      // Verify Patient
      const patient = await Patient.findOne({ _id: patientId, deletedAt: null });
      if (!patient) {
        throw new CommandError(404, "Patient profile not found");
      }
      if (patient.organizationId && locationAccess.organizationId && patient.organizationId.toString() !== locationAccess.organizationId) {
        throw new CommandError(404, "Patient profile not found");
      }
      if (!patient.organizationId && locationAccess.organizationId) {
        patient.organizationId = new mongoose.Types.ObjectId(locationAccess.organizationId);
        await patient.save();
      }

      // Load and validate stocks
      const medsToUpdate: any[] = [];
      const medicineIds = new Set<string>();

      // Validate item structure and collect IDs
      for (const item of items) {
        if (!mongoose.Types.ObjectId.isValid(item.medicineId)) {
          throw new CommandError(400, `Invalid medicineId: ${item.medicineId}`);
        }
        if (!item.quantity || item.quantity <= 0) {
          throw new CommandError(400, "Item quantities must be positive integers");
        }
        if (!Number.isSafeInteger(item.quantity)) {
          throw new CommandError(400, "Item quantities must be positive safe integers");
        }
        if (medicineIds.has(item.medicineId)) {
          throw new CommandError(400, "Each medicine may appear only once per dispense request");
        }
        medicineIds.add(item.medicineId);
      }

      // Batch query all requested medicines in a single database roundtrip
      const medicineDocs = await Medicine.find({ _id: { $in: Array.from(medicineIds) }, deletedAt: null });
      const medicineMap = new Map(medicineDocs.map((m) => [m._id.toString(), m]));

      for (const item of items) {
        const medicine = medicineMap.get(item.medicineId);
        if (!medicine) {
          throw new CommandError(404, `Medicine ID ${item.medicineId} not found`);
        }
        if (medicine.locationId.toString() !== locationId) {
          throw new CommandError(404, `Medicine ID ${item.medicineId} not found in selected location`);
        }

        if (medicine.stockQuantity < item.quantity) {
          throw new CommandError(400, `Insufficient stock for ${medicine.name}. Available: ${medicine.stockQuantity}, Requested: ${item.quantity}`);
        }

        medsToUpdate.push({
          medicine,
          deductAmount: item.quantity
        });
      }
      const dispensedResults: Array<{ medicine: any; item: { quantity: number }; result: any }> = [];
      for (const m of medsToUpdate) {
        const result = await dispenseMedicineFEFO(m.medicine._id.toString(), locationId, m.deductAmount, session, {
          organizationId: authority.organizationId, patientId, doctorId: invoiceDoctorId, encounterId: resolvedEncounterId,
          dispenseId, invoiceId, dispensedBy: userId, dispensedAt: issuedAt,
          prescriptionAllocations: source.mappings.filter(rx => rx.medicineId === String(m.medicine._id)),
        });
        dispensedResults.push({ medicine: m.medicine, item: { quantity: m.deductAmount }, result });
      }

      const supplyLines = dispensedResults.map(({ medicine, item, result }) => {
        const priced = pricePharmacySupply(medicine, result.pricedAllocations, issuer);
        return {
          _id: new mongoose.Types.ObjectId(), medicineId: medicine._id,
          description: `Prescription Medicine: ${medicine.name} (Batch: ${result.dispensedBatches.length ? result.dispensedBatches.map((batch: any) => batch.batchNumber).join(", ") : medicine.batchNumber || "aggregate stock"})`,
          ...priced, amount: priced.baseAmountPaise / 100 / item.quantity, quantity: item.quantity, lineAmount: priced.grossAmountPaise / 100,
          prescriptions: source.mappings.filter(rx => rx.medicineId === String(medicine._id)).map(rx => ({
            prescriptionId: rx.prescriptionId, quantity: rx.quantity,
          })), batches: result.dispensedBatches, pricingAllocations: result.pricedAllocations,
        };
      });
      const sumPaise = (key: "baseAmountPaise" | "cgstPaise" | "sgstPaise" | "grossAmountPaise") => {
        const total = supplyLines.reduce((sum, line) => sum + line[key], 0);
        if (!Number.isSafeInteger(total)) throw new CommandError(409, "Pharmacy document amount exceeds the supported bound");
        return total;
      };
      const subtotal = sumPaise("baseAmountPaise") / 100;
      const cgstTotal = sumPaise("cgstPaise") / 100, sgstTotal = sumPaise("sgstPaise") / 100;
      const totalAmount = sumPaise("grossAmountPaise") / 100;
      if (totalAmount >= 50000 && (!patient.address || !/^(0[1-9]|[12][0-9]|3[0-8])$/.test(patient.state || ""))) {
        throw new CommandError(409, "A recipient address and explicit GST state code are required for this pharmacy document value");
      }
      const taxDocument = await pharmacyDocumentSnapshot(issuer, patient, userId, issuedAt, supplyLines);
      const numbering = await allocateInvoiceNumber(locationId, issuedAt);
      const invoiceItems = supplyLines.map(line => ({
        ...line, pharmacyDispenseId: dispenseId, pharmacyDispenseLineId: line._id,
        cgstAmount: line.cgstPaise / 100, sgstAmount: line.sgstPaise / 100, igstAmount: 0, totalItemAmount: line.lineAmount,
      }));
      await createWithSession(PharmacyDispense, {
        _id: dispenseId, ...authority, patientId, doctorId: invoiceDoctorId,
        encounterId: resolvedEncounterId, appointmentId: resolvedAppointmentId,
        clinicalNoteId: source.note?._id, focusedCompletionAuditId: source.focusedCompletion?._id,
        prescriptionIds, invoiceId, operationKey: key, lines: supplyLines, prescriptionProgress: source.quantitySnapshots,
      }, session);

      // Supply issues its own document. Clinical drafts and previously issued bills remain unchanged.
      const createdInvoice = await createWithSession(Invoice, {
        _id: invoiceId, ...numbering, documentVersion: 1, issuedAt, taxDocument, currency: "INR",
        clinicalChargeVersion: 1, supplementForInvoiceId: parentInvoice?._id,
        patientId, locationId, organizationId: authority.organizationId, doctorId: invoiceDoctorId,
        appointmentId: resolvedAppointmentId, encounterId: resolvedEncounterId,
        supplierGstin: issuer.gstin, placeOfSupply: issuer.stateCode, isInterstate: false, invoiceType: "B2C",
        items: invoiceItems, subtotal, taxableAmount: subtotal, tax: (sumPaise("cgstPaise") + sumPaise("sgstPaise")) / 100,
        cgstTotal, sgstTotal, igstTotal: 0, discount: 0, totalAmount, balanceDue: totalAmount, status: "unpaid",
      }, session);
      if (resolvedAppointmentId) {
        const activeBills = visitInvoices.filter(invoice => !["cancelled", "refunded"].includes(invoice.status));
        const outstanding = totalAmount + activeBills.reduce((sum, invoice) => sum + Math.max(0, invoice.totalAmount - (invoice.amountPaid || 0)), 0);
        const paid = activeBills.reduce((sum, invoice) => sum + (invoice.amountPaid || 0), 0);
        await Appointment.updateOne({ _id: resolvedAppointmentId, organizationId: authority.organizationId, locationId, patientId },
          { $set: { paymentStatus: outstanding <= 0 ? "paid" : paid > 0 ? "partially_paid" : "unpaid" } });
      }

      await createWithSession(AuditLog, {
        userId,
        action: "PRESCRIPTION_DISPENSE",
        targetId: createdInvoice._id,
        targetModel: "Invoice",
        organizationId: locationAccess.organizationId || undefined,
details: { dispenseId, invoiceNumber: createdInvoice.invoiceNumber, totalAmount, itemCount: items.length, prescriptionProgress: source.quantitySnapshots }
      }, session);

      await fulfillAuthorizedPrescriptions(source, dispenseId);

      return { invoice: createdInvoice, addedAmount: totalAmount, appendedToExisting: false, prescriptionProgress: source.quantitySnapshots,
        allocations: dispensedResults.map(({ medicine, item, result }) => ({
          medicineId: String(medicine._id), quantity: item.quantity, lineAmount: result.totalCost, batches: result.dispensedBatches,
        })) };
    }));
    // Notifications happen after commit and only for the first successful command.
    if (!result.replayed) {
      try {
        const { broadcastQueueUpdate } = await import("../notifications/websocket.ts");
        broadcastQueueUpdate(authority.locationId, { type: "PRESCRIPTION_DISPENSED", data: {
          appointmentId: result.data.appointmentId || input.appointmentId,
          encounterId: result.data.encounterId || input.encounterId,
          patientId: input.patientId, locationId: authority.locationId,
          invoiceId: result.data.dispenseOperation.invoiceId, invoiceNumber: result.data.invoiceNumber,
          totalAmount: result.data.totalAmount, balanceDue: result.data.balanceDue,
          dispensedCount: input.items.length, status: result.data.dispenseOperation.prescriptionProgress?.some((row: { completed: boolean }) => !row.completed) ? "partially_dispensed" : "dispensed",
        }, timestamp: new Date().toISOString() });
      } catch (error) { console.warn("Pharmacy dispense notification failed:", safeError(error)); }
    }
    reply.header("Idempotency-Replayed", String(result.replayed));
    return reply.code(result.replayed ? 200 : 201).send(successResponse(result.data, "Medications dispensed and billed successfully"));
  } catch (err) {
    if (err instanceof PharmacyInventoryError || err instanceof CommandError) return reply.code(err.statusCode).send(errorResponse(err.message));
    if ((err as { statusCode?: number })?.statusCode === 428) return reply.code(428).send(errorResponse("A stable Idempotency-Key is required for dispensing"));
    const message = err instanceof Error ? err.message : "";
    if (message.startsWith("Insufficient") || message.includes("expired") || message.includes("allocate")) return reply.code(400).send(errorResponse(message));
    console.error("dispensePrescription error:", safeError(err));
    return reply.code(500).send(errorResponse("Dispense outcome could not be confirmed. Keep the same reference and check its result."));
  }
}

export async function getDispenseOperationController(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const { key } = req.params as { key: string };
    const { locationId } = req.query as { locationId?: string };
    if (!locationId) return reply.code(400).send(errorResponse("locationId is required"));
    const access = await checkLocationAccess(req, locationId);
    if (!access.allowed) return sendTenantError(reply, access);
    const data = await getDispenseOperation({ organizationId: access.organizationId!, locationId: locationId.toLowerCase(), actorId: req.user!.id }, key);
    reply.header("Cache-Control", "no-store");
    return reply.code(200).send(successResponse(data, "Committed dispense recovered"));
  } catch (err) {
    if (err instanceof CommandError) return reply.code(err.statusCode).send(errorResponse(err.message));
    console.error("getDispenseOperation error:", safeError(err));
    return reply.code(500).send(errorResponse("Unable to check dispense outcome. Keep the same reference."));
  }
}
// ─── Multi-Batch Pharmacy Inventory Handlers ─────────────────────

export async function createMedicineBatch(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { medicineId, locationId, batchNumber, expiryDate, quantity, purchaseCost, sellingPrice, mrp, hsnCode, gstRate, unlinkedInwardReason, purchaseId } = req.body as any;

    if (!medicineId || !locationId || !batchNumber || !expiryDate || quantity === undefined || purchaseCost === undefined || sellingPrice === undefined) {
      return reply.code(400).send(errorResponse("medicineId, locationId, batchNumber, expiryDate, quantity, purchaseCost, and sellingPrice are required"));
    }

    if (!mongoose.Types.ObjectId.isValid(medicineId) || !mongoose.Types.ObjectId.isValid(locationId)) {
      return reply.code(400).send(errorResponse("Invalid medicine or location ID"));
    }
    const locationAccess = await checkLocationAccess(req, locationId);
    if (!locationAccess.allowed) return sendTenantError(reply, locationAccess);
    const medicine = await Medicine.findOne({ _id: medicineId, deletedAt: null });
    if (!medicine) return reply.code(404).send(errorResponse("Medicine record not found"));
    const medicineAccess = await checkOperationalRecordAccess(req, medicine);
    if (!medicineAccess.allowed) return sendTenantError(reply, medicineAccess);
    if (medicine.locationId.toString() !== locationId) return reply.code(404).send(errorResponse("Medicine not found in selected location"));
    if (purchaseId !== undefined || typeof unlinkedInwardReason !== "string" || unlinkedInwardReason.trim().length < 3 || unlinkedInwardReason.trim().length > 200) return reply.code(400).send(errorResponse("Record an explicit unlinked inward reason. Supplier-bill deliveries must use purchase receipts."));
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || !Number.isFinite(purchaseCost) || purchaseCost < 0 || !Number.isFinite(sellingPrice) || sellingPrice < 0) {
      return reply.code(400).send(errorResponse("Quantity must be a positive integer and prices must be non-negative numbers"));
    }

    const { addBatchToMedicine } = await import("../services/PharmacyInventoryService.ts");
    const batch = await addBatchToMedicine({
      medicineId,
      locationId,
      batchNumber,
      expiryDate,
      quantity,
      purchaseCost,
      sellingPrice,
      mrp,
      hsnCode,
      gstRate,
      unlinkedInwardReason: unlinkedInwardReason.trim(),
    });

    const result = batch.toJSON();
    if (!await pharmacyRequestAllows(req, "viewCost")) delete result.purchaseCost;
    return reply.code(201).send(successResponse(result, "Medicine batch stock added successfully"));
  } catch (err: any) {
    if (err instanceof PharmacyInventoryError || err instanceof CommandError) return reply.code(err.statusCode).send(errorResponse(err.message));
    console.error("createMedicineBatch error:", safeError(err));
    return reply.code(500).send(errorResponse(err.message || "Internal server error"));
  }
}

export async function getMedicineBatches(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid medicine ID"));
    }

    const { MedicineBatch } = await import("../models/MedicineBatch.ts");
    const medicine = await Medicine.findById(id);
    if (!medicine) return reply.code(404).send(errorResponse("Medicine not found"));
    const medicineAccess = await checkOperationalRecordAccess(req, medicine);
    if (!medicineAccess.allowed) return sendTenantError(reply, medicineAccess);
    const canManage = await pharmacyRequestAllows(req, "viewCost");
    const batches = await MedicineBatch.find({ medicineId: id, locationId: medicine.locationId })
      .select(canManage ? "" : "-purchaseCost -costBasis")
      .sort({ expiryDate: 1 });

    return reply.code(200).send(successResponse(batches));
  } catch (err) {
    console.error("getMedicineBatches error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getExpiringMedicinesController(req: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  try {
    const { locationId, days } = req.query as { locationId?: string; days?: string | number };
    const targetLocationId = locationId || (req as any).user?.locationId;
    if (!targetLocationId || !mongoose.Types.ObjectId.isValid(targetLocationId)) {
      return reply.code(200).send(successResponse([]));
    }

    const locationAccess = await checkLocationAccess(req, targetLocationId);
    if (!locationAccess.allowed) return sendTenantError(reply, locationAccess);

    const daysThreshold = days === undefined ? 30 : Number(days);
    if (!Number.isInteger(daysThreshold) || daysThreshold < 0 || daysThreshold > 36500 || days !== undefined && !/^\d+$/.test(String(days))) {
      return reply.code(400).send(errorResponse("days must be a non-negative integer up to 36500"));
    }
    const { getExpiringBatches } = await import("../services/PharmacyInventoryService.ts");
    const canManage = await pharmacyRequestAllows(req, "viewCost");
    const expiring = await getExpiringBatches(targetLocationId, daysThreshold, canManage);

    return reply.code(200).send(successResponse(expiring));
  } catch (err) {
    if (err instanceof PharmacyInventoryError || err instanceof CommandError) return reply.code(err.statusCode).send(errorResponse(err.message));
    console.error("getExpiringMedicinesController error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function adjustStock(req: FastifyRequest, reply: FastifyReply) {
  try {
    const input = req.body as StockAdjustmentInput;
    const { medicineId, newQuantity, reason } = input;

    if (!medicineId || newQuantity === undefined || !reason) {
      return reply.code(400).send(errorResponse("medicineId, newQuantity, and reason are required"));
    }

    if (!mongoose.Types.ObjectId.isValid(medicineId)) {
      return reply.code(400).send(errorResponse("Invalid medicine ID"));
    }

    if (!Number.isSafeInteger(newQuantity) || newQuantity < 0) {
      return reply.code(400).send(errorResponse("newQuantity must be a non-negative safe integer"));
    }

    const medicine = await Medicine.findOne({ _id: medicineId, deletedAt: null });
    if (!medicine) return reply.code(404).send(errorResponse("Medicine not found"));

    const medicineAccess = await checkOperationalRecordAccess(req, medicine);
    if (!medicineAccess.allowed) return sendTenantError(reply, medicineAccess);
    if (input.expectedQuantity === undefined || input.expectedRevision === undefined || !input.clientRequestId) {
      return reply.code(409).send(errorResponse("Reload stock and submit expectedQuantity, expectedRevision and clientRequestId; unversioned absolute edits are unavailable"));
    }
    const result = await adjustMedicineStock(input, { organizationId: medicineAccess.organizationId!,
      locationId: String(medicine.locationId), actorId: req.user!.id });
    return reply.code(200).send(successResponse(result, "Stock adjustment recorded"));
  } catch (err: any) {
    if (err instanceof PharmacyInventoryError || err instanceof CommandError) return reply.code(err.statusCode).send(errorResponse(err.message));
    console.error("adjustStock error:", safeError(err));
    return reply.code(500).send(errorResponse("Unable to record stock adjustment"));
  }
}

export async function getStockMovements(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) return reply.code(400).send(errorResponse("Invalid medicine ID"));
    // History survives soft deletion, under the same current branch authority.
    const medicine = await Medicine.findById(id);
    if (!medicine) return reply.code(404).send(errorResponse("Medicine not found"));
    const access = await checkOperationalRecordAccess(req, medicine);
    if (!access.allowed) return sendTenantError(reply, access);
    const query = req.query as { limit?: string; beforeRevision?: string };
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    const beforeRevision = query.beforeRevision === undefined ? undefined : Number(query.beforeRevision);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        (beforeRevision !== undefined && (!Number.isSafeInteger(beforeRevision) || beforeRevision < 0))) {
      return reply.code(400).send(errorResponse("Invalid movement page limit or revision cursor"));
    }
    const movements = await StockMovement.find({ medicineId: medicine._id, locationId: medicine.locationId,
      organizationId: access.organizationId, ...(beforeRevision !== undefined ? { revision: { $lt: beforeRevision } } : {}) })
      .sort({ revision: -1 }).limit(limit).lean();
    return reply.code(200).send(successResponse({ movements,
      nextBeforeRevision: movements.length === limit ? movements[movements.length - 1].revision : null }));
  } catch (err) {
    console.error("getStockMovements error:", safeError(err));
    return reply.code(500).send(errorResponse("Unable to read stock movements"));
  }
}
