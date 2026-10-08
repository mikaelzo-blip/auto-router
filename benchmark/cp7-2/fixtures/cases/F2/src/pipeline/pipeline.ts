import { PipelineContext } from "./context.js";
import { PipelineStep } from "./step.js";

export interface PipelineOptions {
  stopOnError?: boolean;
}

export interface PipelineResult {
  success: boolean;
  finalContext: PipelineContext;
  errors: string[];
}

export class Pipeline {
  private readonly steps: PipelineStep[] = [];
  private readonly options: PipelineOptions;

  constructor(options: PipelineOptions = {}) {
    this.options = { stopOnError: true, ...options };
  }

  public addStep(step: PipelineStep): this {
    this.steps.push(step);
    return this;
  }

  public async run(initialContext: PipelineContext): Promise<PipelineResult> {
    let currentCtx = { ...initialContext };
    const errors: string[] = [];

    for (const step of this.steps) {
      try {
        currentCtx = await step.execute(currentCtx);
      } catch (err: any) {
        errors.push(err.message || String(err));
        // DEFECT: does not inspect this.options.stopOnError and crashes or breaks inconsistently
        if (this.options.stopOnError) {
          return {
            success: false,
            finalContext: currentCtx,
            errors
          };
        }
      }
    }

    return {
      success: errors.length === 0,
      finalContext: currentCtx,
      errors
    };
  }
}
