import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { OpdTemplate, type IOpdTemplate } from "../models/OpdTemplate.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { AuditLog } from "../models/AuditLog.ts";

export const STANDARD_OPD_PRESETS = [
  {
    title: "Viral URI & Flu",
    specialty: "General Medicine",
    symptoms: "Acute onset fever, runny nose, sore throat, dry cough, malaise x 3 days",
    diagnosis: "Acute Viral Upper Respiratory Infection (URI)",
    prescriptions: [
      { name: "Paracetamol 650mg", dosage: "1-0-1 (After Food)", duration: "3 days", instructions: "SOS for fever > 100°F" },
      { name: "Cetirizine 10mg", dosage: "0-0-1 (Night)", duration: "5 days", instructions: "Take before bedtime" },
      { name: "Pantoprazole 40mg", dosage: "1-0-0 (Before Food)", duration: "5 days", instructions: "30 mins before breakfast" },
    ],
    advice: "Warm water saline gargles 3x daily. Adequate oral hydration (2-3L fluids/day). Steam inhalation twice daily.",
    followUpRecommended: true,
    followUpTimeline: "1 week",
    followUpNotes: "Review SOS if high fever (>102°F) or breathing difficulty develops.",
    isPublic: true,
  },
  {
    title: "Acute Gastroenteritis",
    specialty: "General Medicine",
    symptoms: "Loose watery stools (4-5 episodes), mild cramping, nausea x 1-2 days",
    diagnosis: "Acute Gastroenteritis with Mild Dehydration",
    prescriptions: [
      { name: "ORS Sachet", dosage: "1 sachet in 1L water", duration: "3 days", instructions: "Sip continuously after each loose stool" },
      { name: "Ofloxacin-Ornidazole 200/500mg", dosage: "1-0-1 (After Food)", duration: "3 days", instructions: "Antibacterial/antiprotozoal coverage" },
      { name: "Pantoprazole 40mg", dosage: "1-0-0 (Before Food)", duration: "5 days", instructions: "Morning before meals" },
      { name: "Racecadotril 100mg", dosage: "1-1-1 (Before Food)", duration: "3 days", instructions: "Antisecretory control" },
    ],
    advice: "Strict light diet (khichdi, curd, banana, coconut water). Avoid raw salads, milk, and oily spices.",
    followUpRecommended: true,
    followUpTimeline: "1 week",
    followUpNotes: "Review immediately if high fever, severe dehydration, or blood in stool occurs.",
    isPublic: true,
  },
  {
    title: "Hypertension Routine Review",
    specialty: "Cardiology / Internal Medicine",
    symptoms: "Asymptomatic regular follow-up. No headache, chest pain, or visual disturbance.",
    diagnosis: "Essential Primary Hypertension (Under Medical Management)",
    prescriptions: [
      { name: "Telmisartan 40mg", dosage: "1-0-0 (Morning)", duration: "1 month", instructions: "Take regularly after breakfast" },
      { name: "Amlodipine 5mg", dosage: "0-0-1 (Night)", duration: "1 month", instructions: "For dual-agent BP maintenance if advised" },
    ],
    advice: "Strict low salt diet (< 5g/day). 30 minutes brisk daily walk. Avoid added salt, pickles, and processed snacks.",
    followUpRecommended: true,
    followUpTimeline: "1 month",
    followUpNotes: "Review for regular BP log verification and serum creatinine check.",
    isPublic: true,
  },
  {
    title: "Type 2 Diabetes Review",
    specialty: "Endocrinology / Internal Medicine",
    symptoms: "Routine diabetic check-up. No polyuria, polydipsia, foot numbness, or hypoglycemic spells.",
    diagnosis: "Type 2 Diabetes Mellitus (Glycemic Management)",
    prescriptions: [
      { name: "Metformin 500mg SR", dosage: "1-0-1 (With Food)", duration: "1 month", instructions: "Take with major meals" },
      { name: "Glimepiride 1mg", dosage: "1-0-0 (Before Food)", duration: "1 month", instructions: "15 minutes before breakfast" },
    ],
    advice: "Daily foot inspection. Low glycemic index, high fiber diet. Always keep glucose sweets handy for hypoglycemia.",
    followUpRecommended: true,
    followUpTimeline: "1 month",
    followUpNotes: "Review with Fasting & Post-Prandial Blood Sugar (FBS/PPBS) and HbA1c test reports.",
    isPublic: true,
  },
  {
    title: "GERD & Dyspepsia",
    specialty: "Gastroenterology",
    symptoms: "Epigastric burning sensation, retrosternal heartburn, acid regurgitation x 1 week",
    diagnosis: "Gastroesophageal Reflux Disease (GERD) & Acid Peptic Dyspepsia",
    prescriptions: [
      { name: "Pantoprazole 40mg + Domperidone 30mg SR", dosage: "1-0-0 (Before Food)", duration: "14 days", instructions: "Take 30 mins before breakfast" },
      { name: "Magaldrate + Simethicone Gel", dosage: "2 tsp (After Food)", duration: "7 days", instructions: "Take after meals SOS for heartburn" },
    ],
    advice: "Avoid late-night heavy meals. Maintain a 2-hour gap between dinner and sleep. Avoid tea, coffee, and sour citrus foods.",
    followUpRecommended: true,
    followUpTimeline: "2 weeks",
    followUpNotes: "Review after 2 weeks for symptom resolution.",
    isPublic: true,
  },
  {
    title: "Allergic Rhinitis",
    specialty: "ENT / Pulmonology",
    symptoms: "Morning paroxysmal sneezing, clear rhinorrhea, nasal congestion, ocular itching x 2 weeks",
    diagnosis: "Allergic Rhinitis & Nasal Hyper-reactivity",
    prescriptions: [
      { name: "Montelukast 10mg + Levocetirizine 5mg", dosage: "0-0-1 (Night)", duration: "10 days", instructions: "Take at bedtime" },
      { name: "Fluticasone Furoate Nasal Spray", dosage: "2 sprays/nostril (Morning)", duration: "14 days", instructions: "Use once daily after clearing nose" },
    ],
    advice: "Avoid dust, aerosols, pet hair, and sudden temperature fluctuations. Wear a protective mask when outdoors.",
    followUpRecommended: true,
    followUpTimeline: "2 weeks",
    followUpNotes: "Review if nasal obstruction or sinus headache develops.",
    isPublic: true,
  },
  {
    title: "Uncomplicated Lower UTI",
    specialty: "Urology / General Medicine",
    symptoms: "Burning micturition, increased urinary frequency, urgency, suprapubic ache x 2 days",
    diagnosis: "Acute Uncomplicated Lower Urinary Tract Infection",
    prescriptions: [
      { name: "Nitrofurantoin 100mg SR", dosage: "1-0-1 (After Food)", duration: "5 days", instructions: "Complete full 5-day course" },
      { name: "Disodium Hydrogen Citrate Syrup", dosage: "2 tsp in water (TDS)", duration: "5 days", instructions: "Take in 1 glass of water after food" },
      { name: "Paracetamol 650mg", dosage: "1-0-1 (After Food)", duration: "3 days", instructions: "For analgesic comfort" },
    ],
    advice: "Consume 3 to 4 liters of water daily. Do not suppress the urge to urinate.",
    followUpRecommended: true,
    followUpTimeline: "1 week",
    followUpNotes: "Review with Urine Routine & Microscopy report.",
    isPublic: true,
  },
  {
    title: "Tension Headache / Migraine",
    specialty: "Neurology / General Medicine",
    symptoms: "Throbbing unilateral/bilateral headache, photophobia, mild nausea x 1 day",
    diagnosis: "Acute Tension Headache / Episodic Migraine",
    prescriptions: [
      { name: "Naproxen 500mg + Domperidone 10mg", dosage: "1 SOS (After Food)", duration: "3 days", instructions: "Take at onset of headache" },
      { name: "Paracetamol 650mg", dosage: "1-0-1 (After Food)", duration: "2 days", instructions: "Mild analgesic backup" },
      { name: "Pantoprazole 40mg", dosage: "1-0-0 (Before Food)", duration: "3 days", instructions: "Gastric safety" },
    ],
    advice: "Rest in a quiet, darkened room during episodes. Maintain regular hydration and consistent sleep schedules.",
    followUpRecommended: true,
    followUpTimeline: "1 week",
    followUpNotes: "Review if headache frequency or intensity increases.",
    isPublic: true,
  },
];

export async function getOpdTemplates(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user?.id;
    const orgId = req.user?.organization_id;

    // Retrieve doctor's custom templates and organization templates
    const query: any = {
      $or: [
        { isPublic: true },
        ...(userId ? [{ doctorId: new mongoose.Types.ObjectId(userId) }] : []),
        ...(orgId ? [{ organizationId: new mongoose.Types.ObjectId(orgId) }] : []),
      ],
    };

    const customTemplates = await OpdTemplate.find(query).sort({ createdAt: -1 }).lean();

    // Map system standard presets with unique IDs
    const systemPresets = STANDARD_OPD_PRESETS.map((p, idx) => ({
      id: `std_preset_${idx}`,
      ...p,
      isSystem: true,
    }));

    // Format custom presets
    const formattedCustom = customTemplates.map((t) => ({
      id: t._id.toString(),
      title: t.title,
      specialty: t.specialty,
      symptoms: t.symptoms,
      diagnosis: t.diagnosis,
      prescriptions: t.prescriptions,
      advice: t.advice,
      followUpRecommended: t.followUpRecommended,
      followUpTimeline: t.followUpTimeline,
      followUpNotes: t.followUpNotes,
      doctorId: t.doctorId?.toString(),
      isPublic: t.isPublic,
      isSystem: false,
    }));

    return reply.code(200).send(
      successResponse(
        {
          systemPresets,
          customPresets: formattedCustom,
          all: [...systemPresets, ...formattedCustom],
        },
        "OPD Clinical Presets retrieved successfully"
      )
    );
  } catch (err: any) {
    req.log.error(err, "Failed to retrieve OPD templates");
    return reply.code(500).send(errorResponse(err.message || "Failed to retrieve OPD presets"));
  }
}

export async function createOpdTemplate(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user?.id;
    const orgId = req.user?.organization_id;
    const body = req.body as any;

    if (!body?.title?.trim()) {
      return reply.code(400).send(errorResponse("Template title is required"));
    }

    const template = await OpdTemplate.create({
      title: body.title.trim(),
      specialty: body.specialty?.trim() || "General Medicine",
      symptoms: body.symptoms || "",
      diagnosis: body.diagnosis || "",
      prescriptions: Array.isArray(body.prescriptions)
        ? body.prescriptions.map((p: any) => ({
            name: p.name?.trim() || "",
            dosage: p.dosage?.trim() || "1-0-1 (After Food)",
            duration: p.duration?.trim() || "5 days",
            instructions: p.instructions?.trim() || "",
          }))
        : [],
      advice: body.advice || "",
      followUpRecommended: Boolean(body.followUpRecommended),
      followUpTimeline: body.followUpTimeline || "1 week",
      followUpNotes: body.followUpNotes || "",
      doctorId: userId ? new mongoose.Types.ObjectId(userId) : undefined,
      clinicId: body.clinicId ? new mongoose.Types.ObjectId(body.clinicId) : undefined,
      organizationId: orgId ? new mongoose.Types.ObjectId(orgId) : undefined,
      isPublic: false,
    });

    await AuditLog.create({
      userId,
      action: "OPD_TEMPLATE_CREATED",
      targetId: template._id,
      targetModel: "OpdTemplate",
      category: "CLINICAL_WRITE",
      details: { title: template.title, prescriptionCount: template.prescriptions.length },
    });

    return reply.code(201).send(
      successResponse(
        {
          id: template._id.toString(),
          title: template.title,
          specialty: template.specialty,
          symptoms: template.symptoms,
          diagnosis: template.diagnosis,
          prescriptions: template.prescriptions,
          advice: template.advice,
          followUpRecommended: template.followUpRecommended,
          followUpTimeline: template.followUpTimeline,
          followUpNotes: template.followUpNotes,
          isSystem: false,
        },
        "Custom OPD Preset saved successfully"
      )
    );
  } catch (err: any) {
    req.log.error(err, "Failed to create OPD template");
    return reply.code(500).send(errorResponse(err.message || "Failed to save custom OPD preset"));
  }
}

export async function deleteOpdTemplate(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const userId = req.user?.id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid template ID"));
    }

    const template = await OpdTemplate.findOne({
      _id: new mongoose.Types.ObjectId(id),
      doctorId: new mongoose.Types.ObjectId(userId),
    });

    if (!template) {
      return reply.code(404).send(errorResponse("Custom preset not found or access denied"));
    }

    await OpdTemplate.findByIdAndDelete(template._id);

    await AuditLog.create({
      userId,
      action: "OPD_TEMPLATE_DELETED",
      targetId: template._id,
      targetModel: "OpdTemplate",
      category: "CLINICAL_WRITE",
      details: { title: template.title },
    });

    return reply.code(200).send(successResponse(null, "Custom OPD Preset deleted successfully"));
  } catch (err: any) {
    req.log.error(err, "Failed to delete OPD template");
    return reply.code(500).send(errorResponse(err.message || "Failed to delete custom OPD preset"));
  }
}
