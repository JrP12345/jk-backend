import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { ServiceCatalog } from "../models/ServiceCatalog.ts";
import { Clinic } from "../models/Clinic.ts";
import { createTenantRepository } from "../platform/TenantRepository.ts";
import { successResponse, errorResponse, escapeRegex, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";
import { resolveAuthorizedOrganizationScope } from "../utilities/tenant.ts";

const serviceCatalogRepo = createTenantRepository(ServiceCatalog);

export async function createService(req: FastifyRequest, reply: FastifyReply) {
  try {
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const orgId = scope.organizationId;
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

    // Validate referenced clinic belongs to the same organization
    let validatedClinicId: mongoose.Types.ObjectId | undefined = undefined;
    if (clinicId) {
      if (!mongoose.Types.ObjectId.isValid(clinicId)) {
        return reply.code(400).send(errorResponse("Invalid clinic ID format"));
      }
      const clinicExists = await Clinic.findOne({ _id: clinicId, organizationId: orgId });
      if (!clinicExists) {
        return reply.code(400).send(errorResponse("Referenced clinic does not belong to your organization"));
      }
      validatedClinicId = new mongoose.Types.ObjectId(clinicId);
    }

    const existing = await serviceCatalogRepo.findOne({
      code: code.trim().toUpperCase(),
    }, undefined, { organizationId: orgId });

    if (existing) {
      return reply.code(409).send(errorResponse(`Service code '${code.toUpperCase()}' already exists in your organization`));
    }

    const service = await serviceCatalogRepo.create({
      organizationId: new mongoose.Types.ObjectId(orgId),
      clinicId: validatedClinicId,
      code: code.trim().toUpperCase(),
      name: name.trim(),
      department: department.trim(),
      category: category || "other",
      price,
      hsnSacCode: hsnSacCode?.trim() || "999312",
      gstRate: gstRate !== undefined ? gstRate : 0,
      description: description?.trim(),
      isActive: isActive !== undefined ? isActive : true,
    }, { organizationId: orgId });

    return reply.code(201).send(successResponse(service, "Service catalog item created successfully"));
  } catch (err) {
    console.error("createService error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getServices(req: FastifyRequest, reply: FastifyReply) {
  try {
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const orgId = scope.organizationId;
    if (!orgId) {
      return reply.code(400).send(errorResponse("Organization ID context is missing"));
    }

    const { search, category, department, clinicId, isActive, page, limit } = req.query as any;
    const { page: currentPage, limit: pageSize, skip } = getPaginationParams({ page, limit });

    const andConditions: any[] = [
      { organizationId: new mongoose.Types.ObjectId(orgId) }
    ];

    if (clinicId && mongoose.Types.ObjectId.isValid(clinicId)) {
      andConditions.push({
        $or: [{ clinicId: new mongoose.Types.ObjectId(clinicId) }, { clinicId: { $exists: false } }, { clinicId: null }],
      });
    }

    if (category && typeof category === "string" && category.trim()) {
      andConditions.push({ category: category.trim() });
    }
    if (department && typeof department === "string" && department.trim()) {
      andConditions.push({ department: department.trim() });
    }
    if (isActive !== undefined && isActive !== "") {
      andConditions.push({ isActive: isActive === "true" || isActive === true });
    }

    if (search && typeof search === "string" && search.trim().length > 0) {
      // Capped and escaped search pattern to prevent regex DoS (Finding: Step 3.3)
      const sanitized = escapeRegex(search.trim().slice(0, 100));
      const reg = new RegExp(sanitized, "i");
      andConditions.push({
        $or: [{ name: reg }, { code: reg }, { department: reg }, { hsnSacCode: reg }],
      });
    }

    const filter = { $and: andConditions };

    const totalCount = await serviceCatalogRepo.countDocuments(filter, { organizationId: orgId });
    const totalPages = Math.ceil(totalCount / pageSize);

    const services = await serviceCatalogRepo.find(filter, undefined, {
      organizationId: orgId,
      sort: { category: 1, name: 1 },
      skip,
      limit: pageSize,
    });

    setPaginationHeaders(reply, { totalCount, totalPages, currentPage, pageSize });

    return reply.code(200).send(successResponse(services));
  } catch (err) {
    console.error("getServices error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getServiceById(req: FastifyRequest, reply: FastifyReply) {
  try {
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const orgId = scope.organizationId;
    if (!orgId) {
      return reply.code(400).send(errorResponse("Organization ID context is missing"));
    }

    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid service ID"));
    }

    const service = await serviceCatalogRepo.findById(id, undefined, { organizationId: orgId });
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
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const orgId = scope.organizationId;
    if (!orgId) {
      return reply.code(400).send(errorResponse("Organization ID context is missing"));
    }

    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid service ID"));
    }

    const service = await serviceCatalogRepo.findById(id, undefined, { organizationId: orgId });
    if (!service) {
      return reply.code(404).send(errorResponse("Service catalog item not found"));
    }

    const {
      clinicId, name, department, category, price, hsnSacCode, gstRate, description, isActive
    } = req.body as any;

    if (clinicId !== undefined) {
      if (clinicId && mongoose.Types.ObjectId.isValid(clinicId)) {
        const clinicExists = await Clinic.findOne({ _id: clinicId, organizationId: orgId });
        if (!clinicExists) {
          return reply.code(400).send(errorResponse("Referenced clinic does not belong to your organization"));
        }
        service.clinicId = new mongoose.Types.ObjectId(clinicId);
      } else {
        service.clinicId = undefined;
      }
    }

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
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const orgId = scope.organizationId;
    if (!orgId) {
      return reply.code(400).send(errorResponse("Organization ID context is missing"));
    }

    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid service ID"));
    }

    const service = await serviceCatalogRepo.findById(id, undefined, { organizationId: orgId });
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
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const orgId = scope.organizationId;
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
