/**
 * Declarative definition of a workflow state machine.
 */
export interface WorkflowDefinition<TState extends string = string> {
  name: string;
  initial: TState;
  terminal: readonly TState[];
  transitions: Record<TState, readonly TState[]>;
}

/**
 * Options passed to transition execution.
 */
export interface TransitionOptions<TState extends string = string, TContext = any> {
  currentState: TState;
  targetState: TState;
  context?: TContext;
  before?: (context?: TContext) => Promise<void> | void;
  after?: (context?: TContext) => Promise<void> | void;
}
