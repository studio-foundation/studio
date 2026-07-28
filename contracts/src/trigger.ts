// A `.trigger.yaml` — an inbound webhook that launches a pipeline run.
//
// Triggers cover the one thing tools and MCP servers cannot: an external system
// pushing to Studio. Everything a trigger does *outbound* belongs in a tool.

export interface TriggerDef {
  name: string;
  version: number;
  description?: string;
  /** Pipeline to launch when the webhook matches. */
  pipeline: string;
  /** Omitted entirely, every signed-or-not delivery matches — same as an empty block. */
  webhook?: {
    hmac?: {
      /** Request header carrying the hex signature, e.g. 'x-hub-signature-256'. */
      header: string;
      /** Shared secret; `${VAR}` is resolved from the environment at load. */
      secret: string;
    };
    /** Conditions over `payload.<path>`, same syntax as a stage `when:`. All must hold. */
    when?: string[];
  };
  /** Pipeline input, with `{{payload.<path>}}` references. */
  input?: Record<string, unknown>;
  /** Run metadata, with `{{payload.<path>}}` references. */
  meta?: Record<string, unknown>;
  /** What to show in the trigger log, with `{{payload.<path>}}` references. */
  log?: {
    external_id?: string;
    external_label?: string;
    external_url?: string;
  };
  /**
   * Command run when a triggered run does not succeed. Values reach it through
   * the environment (`STUDIO_RUN_ID`, `STUDIO_META`, …), never interpolated into
   * the command string — the payload that produced them is untrusted.
   */
  on_failure?: {
    command: string;
    timeout_ms?: number;
  };
}
