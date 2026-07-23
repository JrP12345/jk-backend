/**
 * WorkflowError — domain-agnostic error thrown when a state transition fails.
 * Includes metadata (currentStatus, targetStatus, allowedTransitions, isTerminal)
 * so controller/API layers can reliably map it to HTTP 422 (Unprocessable Entity).
 */
export class WorkflowError extends Error {
  public readonly currentStatus: string;
  public readonly targetStatus: string;
  public readonly allowedTransitions: readonly string[];
  public readonly isTerminal: boolean;

  constructor(
    currentStatus: string,
    targetStatus: string,
    allowedTransitions: readonly string[],
    isTerminal: boolean = false
  ) {
    const message = isTerminal
      ? `Cannot transition workflow from terminal status '${currentStatus}' to '${targetStatus}'.`
      : `Invalid workflow transition from '${currentStatus}' to '${targetStatus}'. Allowed: [${allowedTransitions.join(", ")}].`;

    super(message);
    this.name = "WorkflowError";
    this.currentStatus = currentStatus;
    this.targetStatus = targetStatus;
    this.allowedTransitions = allowedTransitions;
    this.isTerminal = isTerminal;

    // Restore prototype chain for instanceof checks
    Object.setPrototypeOf(this, WorkflowError.prototype);
  }
}
