import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { ServiceCatalog } from "../models/ServiceCatalog.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { successResponse, errorResponse, escapeRegex, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";

export async function createService(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user?.organization_id;
    if (!orgId) {
      return reply.code(400).send(errorResponse("Organization ID context is missing"));
    }

    const {
      clinicId, code, name, department, category, price, hsnSacCode, gstRate, description, isActive
    } = req.body as {
      clinicId?: string;
      code: string;
      name: string;
      department: string;
      category: "consultation" | "procedure" | "lab_test" | "radiology" | "bed_charge" | "pharmacy" | "nursing" | "other";
      price: number;
      hsnSacCode?: string;
      gstRate?: number;
      description?: string;
      isActive?: boolean;
    };

    if (!code || !name || !department || price === undefined) {
      return reply.code(400).send(errorResponse("code, name, department, and price are required"));
    }

    const existing = await ServiceCatalog.findOne({
      organizationId: orgId,
      code: code.trim().toUpperCase(),
    });

    if (existing) {
      return reply.code(409).send(errorResponse(`Service code '${code.toUpperCase()}' already exists in your organization`));
    }

    const service = await ServiceCatalog.create({
      organizationId: orgId,
      clinicId: clinicId && mongoose.Types.ObjectId.isValid(clinicId) ? clinicId : undefined,
      code: code.trim().toUpperCase(),
      name: name.trim(),
      department: department.trim(),
      category: category || "other",
      price,
      hsnSacCode: hsnSacCode?.trim() || "999312",
      gstRate: gstRate !== undefined ? gstRate : 0,
      description: description?.trim(),
      isActive: isActive !== undefined ? isActive : true,
    });

    return reply.code(201).send(successResponse(service, "Service catalog item created successfully"));
  } catch (err) {
    console.error("createService error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getServices(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user?.organization_id;
    const { search, category, department, clinicId, isActive, page, limit } = req.query as any;

    const { page: currentPage, limit: pageSize, skip } = getPaginationParams({ page, limit });

    const filter: any = {};
    if (orgId && req.user?.role !== "root") {
      filter.organizationId = orgId;
    }

    if (clinicId && mongoose.Types.ObjectId.isValid(clinicId)) {
      filter.$or = [{ clinicId }, { clinicId: { $exists: false } }, { clinicId: null }];
    }

    if (category) filter.category = category;
    if (department) filter.department = department;
    if (isActive !== undefined && isActive !== "") {
      filter.isActive = isActive === "true" || isActive === true;
    }

    if (search) {
      const reg = new RegExp(escapeRegex(search), "i");
      filter.$or = [{ name: reg }, { code: reg }, { department: reg }, { hsnSacCode: reg }];
    }

    const totalCount = await ServiceCatalog.countDocuments(filter);
    const totalPages = Math.ceil(totalCount / pageSize);

    const services = await ServiceCatalog.find(filter)
      .sort({ category: 1, name: 1 })
      .skip(skip)
      .limit(pageSize);

    setPaginationHeaders(reply, { totalCount, totalPages, currentPage, pageSize });

    return reply.code(200).send(successResponse(services));
  } catch (err) {
    console.error("getServices error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getServiceById(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid service ID"));
    }

    const service = await ServiceCatalog.findById(id);
    if (!service) {
      return reply.code(404).send(errorResponse("Service catalog item not found"));
    }

    return reply.code(200).send(successResponse(service));
  } catch (err) {
    console.error("getServiceById error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function updateService(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid service ID"));
    }

    const service = await ServiceCatalog.findById(id);
    if (!service) {
      return reply.code(404).send(errorResponse("Service catalog item not found"));
    }

    const {
      name, department, category, price, hsnSacCode, gstRate, description, isActive
    } = req.body as any;

    if (name) service.name = name.trim();
    if (department) service.department = department.trim();
    if (category) service.category = category;
    if (price !== undefined) service.price = price;
    if (hsnSacCode !== undefined) service.hsnSacCode = hsnSacCode.trim();
    if (gstRate !== undefined) service.gstRate = gstRate;
    if (description !== undefined) service.description = description.trim();
    if (isActive !== undefined) service.isActive = isActive;

    await service.save();

    return reply.code(200).send(successResponse(service, "Service catalog item updated successfully"));
  } catch (err) {
    console.error("updateService error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function deleteService(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid service ID"));
    }

    const service = await ServiceCatalog.findById(id);
    if (!service) {
      return reply.code(404).send(errorResponse("Service catalog item not found"));
    }

    // Soft delete by disabling
    service.isActive = false;
    await service.save();

    return reply.code(200).send(successResponse(null, "Service deactivated successfully"));
  } catch (err) {
    console.error("deleteService error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function seedDefaultServices(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user?.organization_id;
    if (!orgId) {
      return reply.code(400).send(errorResponse("Organization ID context is missing"));
    }

    const existingCount = await ServiceCatalog.countDocuments({ organizationId: orgId });
    if (existingCount > 0) {
      return reply.code(200).send(successResponse(null, `Organization already has ${existingCount} services in catalog`));
    }

    const defaultServices = [
      { code: "SRV-CONS-OPD", name: "OPD General Consultation", department: "General Medicine", category: "consultation", price: 500, hsnSacCode: "999312", gstRate: 0, description: "Standard outpatient physician consultation" },
      { code: "SRV-CONS-SPEC", name: "Specialist Consultation", department: "Specialist Medicine", category: "consultation", price: 1000, hsnSacCode: "999312", gstRate: 0, description: "Senior consultant / specialist consultation fee" },
      { code: "SRV-CONS-URGENT", name: "Urgent Care OPD Consultation", department: "General Medicine", category: "consultation", price: 1200, hsnSacCode: "999312", gstRate: 0, description: "Priority walk-in outpatient assessment" },
      { code: "SRV-LAB-CBC", name: "Complete Blood Count (CBC)", department: "Pathology", category: "lab_test", price: 350, hsnSacCode: "999316", gstRate: 0, description: "Full blood cell count & differential" },
      { code: "SRV-LAB-LFT", name: "Liver Function Test (LFT)", department: "Biochemistry", category: "lab_test", price: 800, hsnSacCode: "999316", gstRate: 0, description: "Bilirubin, SGOT, SGPT, Alkaline Phosphatase" },
      { code: "SRV-RAD-XRAY", name: "X-Ray Chest PA View", department: "Radiology", category: "radiology", price: 600, hsnSacCode: "999315", gstRate: 0, description: "Digital chest radiograph" },
      { code: "SRV-RAD-USG", name: "Ultrasound Abdomen & Pelvis", department: "Radiology", category: "radiology", price: 1500, hsnSacCode: "999315", gstRate: 0, description: "Abdominal & pelvic sonography" },
      { code: "SRV-PROC-ECG", name: "12-Lead Electrocardiogram (ECG)", department: "Cardiology", category: "procedure", price: 500, hsnSacCode: "999312", gstRate: 0, description: "Standard 12-lead resting ECG" },
      { code: "SRV-PROC-NEB", name: "Aerosol Nebulization Therapy", department: "Nursing", category: "procedure", price: 200, hsnSacCode: "999312", gstRate: 0, description: "Nebulizer breathing treatment" },
      { code: "SRV-PROC-DRESS", name: "Wound Dressing & Bandaging", department: "Nursing", category: "procedure", price: 250, hsnSacCode: "999312", gstRate: 0, description: "Minor procedure dressing" },
      { code: "SRV-PROC-IV", name: "IV Infusion & Nursing Care", department: "Nursing", category: "nursing", price: 300, hsnSacCode: "999312", gstRate: 0, description: "Intravenous line setup and medication administration" }
    ];

    const inserted = await ServiceCatalog.insertMany(
      defaultServices.map((s) => ({ ...s, organizationId: orgId, isActive: true }))
    );

    return reply.code(201).send(successResponse(inserted, `Seeded ${inserted.length} default service catalog items`));
  } catch (err) {
    console.error("seedDefaultServices error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}
