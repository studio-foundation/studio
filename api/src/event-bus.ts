export type SseEventType =
  | 'stage_start'
  | 'stage_complete'
  | 'stage_retry'
  | 'group_start'
  | 'group_iteration'
  | 'group_feedback'
  | 'group_complete'
  | 'pipeline_complete'
  | 'pipeline_cancelled'
  | 'done';

export interface BusEvent {
  type: SseEventType;
  data: unknown;
}

export type BusListener = (event: BusEvent) => void;

export class RunEventBus {
  private subs = new Map<string, Set<BusListener>>();

  subscribe(runId: string, listener: BusListener): () => void {
    if (!this.subs.has(runId)) {
      this.subs.set(runId, new Set());
    }
    this.subs.get(runId)!.add(listener);
    return () => {
      this.subs.get(runId)?.delete(listener);
    };
  }

  emit(runId: string, type: SseEventType, data: unknown): void {
    const listeners = this.subs.get(runId);
    if (!listeners) return;
    const event: BusEvent = { type, data };
    for (const listener of listeners) {
      listener(event);
    }
  }

  close(runId: string): void {
    this.emit(runId, 'done', {});
    this.subs.delete(runId);
  }
}
