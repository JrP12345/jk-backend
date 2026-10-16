// Exact, source-controlled recovery instructions. Arbitrary exception text must
// never pass through, even when a driver error supplies an HTTP status code.
const recoveryMessages = new Set([
  "Two-factor authentication configuration could not be read. Please contact support.",
  "Workspace selection unavailable; sign in again",
  "Patient search could not be completed. Retry before creating a new record.",
  "Registration could not be confirmed. Retry with the same request identifier.",
  "The booking result could not be confirmed. Retry the submitted request.",
  "The booking result could not be confirmed. Retry the same submitted command.",
  "The walk-in result could not be confirmed. Retry the submitted request.",
  "Prescription message could not be confirmed. Retry the same submitted request.",
  "The review result could not be confirmed. Retry the same command.",
  "The report could not be loaded. Retry or select a smaller range.",
  "The call record result could not be confirmed. Retry the same submitted record.",
  "The inquiry result could not be confirmed. Retry the same request.",
  "The conversion result could not be confirmed. Retry the same request.",
  "The task result could not be confirmed. Retry the same request.",
  "Family authority could not be confirmed. Retry the same submitted review.",
  "The queued message could not be confirmed. Retry the same submitted request.",
  "Message review could not be confirmed. Retry the same submitted review.",
  "The settings result could not be confirmed. Retry the submitted request.",
  "The feedback result could not be confirmed. Retry the submitted request.",
  "The update could not be confirmed. Retry the same request.",
  "Payment status could not be confirmed. Please try again.",
]);
export function publicServerFailureMessage(message: unknown): string {
  return typeof message === "string" && recoveryMessages.has(message)
    ? message : "Unable to complete this request. Please try again.";
}
