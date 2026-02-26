// Linear post-pipeline notifier — posts a failure comment and transitions issue status
// Called as a fire-and-forget side effect from launcher.ts when a pipeline fails/is rejected
// and the run carries linear_issue_id in its metadata.
//
// Success case is handled by the close-ticket stage inside the pipeline itself.
// This module only covers the failure path: QA rejection exhausted, stage failed, etc.

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

export interface LinearFailureNotifyOptions {
  issueId: string;
  runId: string;
  durationMs: number;
  iterations?: number;
  rejectionReason?: string;
  rejectionDetails?: string[];
  /** Override API key — defaults to process.env.LINEAR_API_KEY */
  apiKey?: string;
}

async function gql(
  query: string,
  variables: Record<string, unknown>,
  apiKey: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(LINEAR_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Linear GraphQL HTTP error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<Record<string, unknown>>;
}

function buildFailureComment(opts: LinearFailureNotifyOptions): string {
  const iterLabel = opts.iterations != null ? ` après ${opts.iterations} itérations QA` : '';
  const lines: string[] = [];

  lines.push(`❌ **Code Builder échoué** —${iterLabel ? ` QA a rejeté${iterLabel}` : ' pipeline échoué'}`);
  lines.push('');

  if (opts.rejectionReason) {
    lines.push('**Dernière raison de rejet :**');
    if (opts.rejectionDetails && opts.rejectionDetails.length > 0) {
      for (const detail of opts.rejectionDetails) {
        lines.push(`- ${detail}`);
      }
    } else {
      lines.push(`- ${opts.rejectionReason}`);
    }
    lines.push('');
  }

  lines.push('**Action requise :** réviser le brief ou augmenter max_iterations');
  lines.push('');
  lines.push(`**Run ID :** ${opts.runId}`);

  return lines.join('\n');
}

/**
 * Notify Linear of a pipeline failure.
 * Posts a failure comment and transitions the issue to "Backlog".
 * Never throws — all errors are logged and swallowed (pipeline is already done).
 */
export async function notifyLinearFailure(opts: LinearFailureNotifyOptions): Promise<void> {
  const apiKey = opts.apiKey ?? process.env['LINEAR_API_KEY'];
  if (!apiKey) {
    console.warn('[linear-notifier] LINEAR_API_KEY not set — skipping failure notification');
    return;
  }

  const comment = buildFailureComment(opts);

  try {
    // 1. Post the failure comment
    await gql(
      `mutation CreateComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) { success }
      }`,
      { issueId: opts.issueId, body: comment },
      apiKey,
    );

    // 2. Find the "Backlog" workflow state for this issue's team
    const statesResult = await gql(
      `query GetWorkflowStates($issueId: String!) {
        issue(id: $issueId) {
          team { states { nodes { id name } } }
        }
      }`,
      { issueId: opts.issueId },
      apiKey,
    );

    type StateNode = { id: string; name: string };
    const nodes =
      (
        (statesResult as { data?: { issue?: { team?: { states?: { nodes?: StateNode[] } } } } })
          .data?.issue?.team?.states?.nodes
      ) ?? [];

    const backlogState = nodes.find((s: StateNode) => s.name === 'Backlog');

    // 3. Transition issue to Backlog (best-effort — if state not found, comment is still posted)
    if (backlogState) {
      await gql(
        `mutation UpdateIssue($id: String!, $stateId: String!) {
          issueUpdate(id: $id, input: { stateId: $stateId }) { success }
        }`,
        { id: opts.issueId, stateId: backlogState.id },
        apiKey,
      );
    } else {
      console.warn(
        `[linear-notifier] "Backlog" state not found for issue ${opts.issueId} — status not updated`,
      );
    }

    console.log(`[linear-notifier] Failure notification posted for issue ${opts.issueId}`);
  } catch (err) {
    // Log and swallow — the pipeline completed successfully from Studio's perspective
    console.error('[linear-notifier] Failed to notify Linear:', err);
  }
}
