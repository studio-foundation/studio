export type SseEventType =
  | 'pipeline_start'
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
export type GlobalBusListener = (runId: string, event: BusEvent) => void;

export class RunEventBus {
  private subs = new Map<string, Set<BusListener>>();
  private globalListeners = new Set<GlobalBusListener>();

  subscribe(runId: string, listener: BusListener): () => void {
    if (!this.subs.has(runId)) {
      this.subs.set(runId, new Set());
    }
    this.subs.get(runId)!.add(listener);
    return () => {
      this.subs.get(runId)?.delete(listener);
    };
  }

  // Global subscription — receives all events across all runs
  subscribeAll(listener: GlobalBusListener): () => void {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  emit(runId: string, type: SseEventType, data: unknown): void {
    const event: BusEvent = { type, data };
    const listeners = this.subs.get(runId);
    if (listeners) {
      for (const listener of listeners) {
        listener(event);
      }
    }
    for (const listener of this.globalListeners) {
      listener(runId, event);
    }
  }

  close(runId: string): void {
    this.emit(runId, 'done', {});
    this.subs.delete(runId);
  }
}
