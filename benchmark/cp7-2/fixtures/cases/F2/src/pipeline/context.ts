export interface PipelineContext {
  data: Record<string, any>;
  metadata: Record<string, any>;
}

export function createInitialContext(initialData: Record<string, any> = {}): PipelineContext {
  return {
    data: { ...initialData },
    metadata: { startedAt: Date.now() }
  };
}
