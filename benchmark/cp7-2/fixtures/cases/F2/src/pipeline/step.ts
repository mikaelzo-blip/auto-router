import { PipelineContext } from "./context.js";

export interface PipelineStep {
  name: string;
  execute: (ctx: PipelineContext) => Promise<PipelineContext> | PipelineContext;
}
