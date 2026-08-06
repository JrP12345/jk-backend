import mongoose, { Schema } from "mongoose";

const AmbulanceDispatchSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
    vehicleNumber: { type: String, required: true, trim: true, index: true },
    vehicleType: {
      type: String,
      enum: ["advanced_life_support", "basic_life_support", "neonatal_transport", "patient_transfer"],
      default: "advanced_life_support",
      index: true,
    },
    callPriority: {
      type: String,
      enum: ["code_red_critical", "code_yellow_urgent", "code_green_routine"],
      required: true,
      index: true,
    },
    patientName: { type: String, required: true, trim: true, index: true },
    pickupLocation: { type: String, required: true, trim: true },
    destinationHospitalUnit: { type: String, required: true, trim: true },
    paramedicLead: { type: String, required: true, trim: true },
    driverName: { type: String, required: true, trim: true },
    dispatchStatus: {
      type: String,
      enum: ["dispatched", "en_route_to_scene", "on_scene", "transporting_to_er", "arrived_er", "available_in_bay"],
      default: "dispatched",
      index: true,
    },
    gpsCoordinates: {
      latitude: { type: Number },
      longitude: { type: Number },
      lastGpsUpdate: { type: Date },
    },
    speedKmh: { type: Number, default: 0 },
    oxygenLevelPercent: { type: Number, default: 100 },
    etaMinutes: { type: Number, default: 10 },
    vitalsEnroute: {
      hr: { type: Number },
      bp: { type: String },
      spo2: { type: Number },
    },
    fuelPercent: { type: Number, default: 85 },
    notes: { type: String, default: "" },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

AmbulanceDispatchSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

AmbulanceDispatchSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const AmbulanceDispatch = mongoose.model("AmbulanceDispatch", AmbulanceDispatchSchema);
