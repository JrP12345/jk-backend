const placeholders = /^(address not recorded|local walk-in|walk-in patient|prescribing physician|nmc-(unspecified|reg-pending)|registered pharmacist|dispensing pharmacist)$/i;
export const genuineDetail = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && !placeholders.test(value.trim());
