export const PHARMACY_PERMISSION_CATALOG = [
  ["PHARMACY_VIEW_STOCK", "View pharmacy stock"], ["PHARMACY_MANAGE_CATALOG", "Manage pharmacy catalogue"],
  ["PHARMACY_RECEIVE_STOCK", "Receive pharmacy stock"], ["PHARMACY_ADJUST_STOCK", "Adjust pharmacy stock"],
  ["PHARMACY_VIEW_COST", "View pharmacy acquisition costs"], ["PHARMACY_VIEW_RX_QUEUE", "View prescription dispensing queue"],
  ["PHARMACY_DISPENSE_RESTRICTED", "Dispense prescribed medicines"], ["PHARMACY_EXPORT_REGISTER", "Read and export pharmacy registers"],
  ["PHARMACY_MANAGE_SETTINGS", "Manage location pharmacy capability"], ["PHARMACY_SELL", "Make pharmacy counter sales"],
  ["PHARMACY_COLLECT_PAYMENT", "Collect pharmacy payments"], ["PHARMACY_PURCHASE", "Manage pharmacy purchases"],
  ["PHARMACY_RETURN", "Process pharmacy returns"], ["PHARMACY_APPROVE_REFUND", "Approve pharmacy refunds"],
  ["PHARMACY_CLOSE_TILL", "Close pharmacy till"], ["PHARMACY_VIEW_REPORTS", "View pharmacy reports"],
  ["PHARMACY_TRANSFER", "Transfer pharmacy stock"],
].map(([code, name]) => ({ code, name, category: "Pharmacy", description: name }));

export const PHARMACY_ACTION_GRANTS = {
  viewStock: ["PHARMACY_VIEW_STOCK", "MANAGE_MEDICINES", "VIEW_EHR"],
  viewCost: ["PHARMACY_VIEW_COST", "MANAGE_MEDICINES"],
  manageCatalog: ["PHARMACY_MANAGE_CATALOG", "MANAGE_MEDICINES"],
  receiveStock: ["PHARMACY_RECEIVE_STOCK", "MANAGE_MEDICINES"],
  adjustStock: ["PHARMACY_ADJUST_STOCK", "MANAGE_MEDICINES"],
  viewRxQueue: ["PHARMACY_VIEW_RX_QUEUE", "MANAGE_MEDICINES", "VIEW_EHR"],
  dispense: ["PHARMACY_DISPENSE_RESTRICTED", "MANAGE_MEDICINES"],
  recoverDispense: ["PHARMACY_DISPENSE_RESTRICTED", "MANAGE_MEDICINES"],
  readRegister: ["PHARMACY_EXPORT_REGISTER", "MANAGE_MEDICINES", "VIEW_EHR"],
  exportRegister: ["PHARMACY_EXPORT_REGISTER", "MANAGE_MEDICINES"],
  readMovements: ["PHARMACY_VIEW_REPORTS", "PHARMACY_ADJUST_STOCK", "PHARMACY_RECEIVE_STOCK", "MANAGE_MEDICINES"],
  manageSettings: ["PHARMACY_MANAGE_SETTINGS", "MANAGE_ORGANIZATION"],
  viewPurchases: ["PHARMACY_PURCHASE", "MANAGE_ORGANIZATION"],
  managePurchases: ["PHARMACY_PURCHASE", "MANAGE_ORGANIZATION"],
  viewSales: ["PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT", "MANAGE_ORGANIZATION"],
  sell: ["PHARMACY_SELL", "MANAGE_ORGANIZATION"],
  collect: ["PHARMACY_COLLECT_PAYMENT", "MANAGE_ORGANIZATION"],
  processReturn: ["PHARMACY_RETURN", "MANAGE_ORGANIZATION"],
  approveReturn: ["PHARMACY_APPROVE_REFUND", "MANAGE_ORGANIZATION"],
  viewReturns: ["PHARMACY_RETURN", "PHARMACY_APPROVE_REFUND", "PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT", "MANAGE_ORGANIZATION"],
  settle: ["PHARMACY_APPROVE_REFUND", "MANAGE_ORGANIZATION"],
  viewSettlements: ["PHARMACY_APPROVE_REFUND", "PHARMACY_PURCHASE", "PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT", "MANAGE_ORGANIZATION"],
  openingBalances: ["MANAGE_ORGANIZATION"],
  viewTill: ["PHARMACY_CLOSE_TILL", "PHARMACY_COLLECT_PAYMENT", "PHARMACY_APPROVE_REFUND", "PHARMACY_VIEW_REPORTS", "MANAGE_ORGANIZATION"],
  openTill: ["PHARMACY_CLOSE_TILL", "PHARMACY_COLLECT_PAYMENT", "PHARMACY_APPROVE_REFUND", "MANAGE_ORGANIZATION"],
  closeTill: ["PHARMACY_CLOSE_TILL", "MANAGE_ORGANIZATION"],
  moveTillCash: ["PHARMACY_CLOSE_TILL", "PHARMACY_APPROVE_REFUND", "MANAGE_ORGANIZATION"],
  viewReports: ["PHARMACY_VIEW_REPORTS", "MANAGE_ORGANIZATION"],
  transferStock: ["PHARMACY_TRANSFER", "MANAGE_ORGANIZATION"],
} as const;
export type PharmacyAction = keyof typeof PHARMACY_ACTION_GRANTS;
export const PHARMACY_NEW_ACTIVITY = new Set<PharmacyAction>(["manageCatalog", "receiveStock", "adjustStock", "viewRxQueue", "dispense", "managePurchases", "sell", "collect", "openingBalances"]);
export function pharmacyAllows(permissions: ReadonlySet<string>, action: PharmacyAction, root = false) {
  return root || PHARMACY_ACTION_GRANTS[action].some(code => permissions.has(code));
}

// Explicit custom-role templates only. Reading these never seeds or overwrites Role records.
export const PHARMACY_ROLE_PRESETS = [
  { name: "pharmacy_owner", label: "Pharmacy owner", permissions: PHARMACY_PERMISSION_CATALOG.map(permission => permission.code) },
  { name: "pharmacy_pharmacist", label: "Dispensing pharmacist", permissions: ["PHARMACY_VIEW_STOCK", "PHARMACY_VIEW_RX_QUEUE", "PHARMACY_DISPENSE_RESTRICTED", "PHARMACY_EXPORT_REGISTER"] },
  { name: "pharmacy_stock_manager", label: "Pharmacy stock manager", permissions: ["PHARMACY_VIEW_STOCK", "PHARMACY_MANAGE_CATALOG", "PHARMACY_RECEIVE_STOCK", "PHARMACY_ADJUST_STOCK", "PHARMACY_VIEW_COST", "PHARMACY_PURCHASE", "PHARMACY_VIEW_REPORTS"] },
  { name: "pharmacy_cashier", label: "Pharmacy cashier", permissions: ["PHARMACY_VIEW_STOCK", "PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT", "PHARMACY_CLOSE_TILL"] },
].map(preset => ({ ...preset, description: `${preset.label}; location grants and professional evidence are checked separately`, permissions: ["VIEW_LOCATIONS", ...preset.permissions] }));
