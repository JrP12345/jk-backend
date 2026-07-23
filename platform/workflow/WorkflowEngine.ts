import type { WorkflowDefinition, TransitionOptions } from "./types.ts";
import { WorkflowError } from "./WorkflowError.ts";

/**
 * WorkflowEngine — generic, persistence-agnostic state machine engine.
 *
 * Responsibilities:
 * - Validate forward state transitions against a declarative WorkflowDefinition.
 * - Protect terminal states from illegal transitions.
 * - Execute before/after lifecycle hooks cleanly.
 * - Remain 100% domain-agnostic (zero imports from models or clinical services).
 */
export class WorkflowEngine<TState extends string = string> {
  public readonly definition: WorkflowDefinition<TState>;
  private readonly terminalSet: Set<TState>;

  constructor(definition: WorkflowDefinition<TState>) {
    this.definition = definition;
    this.terminalSet = new Set(definition.terminal);
  }

  /**
   * Returns true if the specified state is a terminal state.
   */
  public isTerminal(state: TState): boolean {
    return this.terminalSet.has(state);
  }

  /**
   * Returns the list of allowed target states from the current state.
   */
  public getAllowedTransitions(currentState: TState): readonly TState[] {
    return this.definition.transitions[currentState] ?? [];
  }

  /**
   * Validates whether a state transition is allowed.
   * Throws WorkflowError if invalid or if attempting to leave a terminal state.
   */
  public validateTransition(currentState: TState, targetState: TState): void {
    if (this.isTerminal(currentState)) {
      throw new WorkflowError(currentState, targetState, [], true);
    }

    const allowed = this.getAllowedTransitions(currentState);
    if (!allowed.includes(targetState)) {
      throw new WorkflowError(currentState, targetState, allowed, false);
    }
  }

  /**
   * Executes a state transition.
   * Persistence-agnostic: operates on state values and optional context.
   */
  public async transition<TContext = any>(
    options: TransitionOptions<TState, TContext>
  ): Promise<{ previousState: TState; state: TState }> {
    const { currentState, targetState, context, before, after } = options;

    // 1. Assert transition validity
    this.validateTransition(currentState, targetState);

    // 2. Execute pre-transition hook
    if (before) {
      await before(context);
    }

    const result = { previousState: currentState, state: targetState };

    // 3. Execute post-transition hook
    if (after) {
      await after(context);
    }

    return result;
  }
}
