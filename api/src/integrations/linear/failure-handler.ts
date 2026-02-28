// api/src/integrations/linear/failure-handler.ts
import type { FailureHandler, FailureHandlerContext } from '../types.js';

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

async function gql(query: string, variables: Record<string, unknown>, apiKey: string): Promise<Record<string, unknown>> {
  const res = await fetch(LINEAR_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Linear GraphQL HTTP error: ${res.status} ${res.statusText}`);
  return res.json() as Promise<Record<string, unknown>>;
}

function buildFailureComment(ctx: FailureHandlerContext): string {
  const iterations = ctx.lastGroupFeedback?.iteration;
  const iterLabel = iterations != null ? ` après ${iterations} itérations QA` : '';
  const rejectionReason = ctx.lastGroupFeedback?.rejection_reason;
  const rejectionDetails = ctx.lastGroupFeedback?.rejection_details;
  const lines: string[] = [];
  lines.push(`❌ **Code Builder échoué** —${iterLabel ? ` QA a rejeté${iterLabel}` : ' pipeline échoué'}`);
  lines.push('');
  if (rejectionReason) {
    lines.push('**Dernière raison de rejet :**');
    if (rejectionDetails && rejectionDetails.length > 0) {
      for (const detail of rejectionDetails) lines.push(`- ${detail}`);
    } else {
      lines.push(`- ${rejectionReason}`);
    }
    lines.push('');
  }
  lines.push('**Action requise :** réviser le brief ou augmenter max_iterations');
  lines.push('');
  lines.push(`**Run ID :** ${ctx.runId}`);
  return lines.join('\n');
}

export class LinearFailureHandler implements FailureHandler {
  async handleFailure(ctx: FailureHandlerContext): Promise<void> {
    const issueId = typeof ctx.meta['linear_issue_id'] === 'string' ? ctx.meta['linear_issue_id'] : undefined;
    if (!issueId) return;

    const apiKey = (ctx.integrationConfig['LINEAR_API_KEY'] as string | undefined)
      ?? process.env['LINEAR_API_KEY'];
    if (!apiKey) {
      console.warn('[linear-failure-handler] LINEAR_API_KEY not set — skipping failure notification');
      return;
    }

    const comment = buildFailureComment(ctx);
    try {
      await gql(
        `mutation CreateComment($issueId: String!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) { success }
        }`,
        { issueId, body: comment },
        apiKey,
      );

      const statesResult = await gql(
        `query GetWorkflowStates($issueId: String!) {
          issue(id: $issueId) { team { states { nodes { id name } } } }
        }`,
        { issueId },
        apiKey,
      );

      type StateNode = { id: string; name: string };
      const nodes = (
        (statesResult as { data?: { issue?: { team?: { states?: { nodes?: StateNode[] } } } } })
          .data?.issue?.team?.states?.nodes
      ) ?? [];
      const backlogState = nodes.find((s: StateNode) => s.name === 'Backlog');

      if (backlogState) {
        await gql(
          `mutation UpdateIssue($id: String!, $stateId: String!) {
            issueUpdate(id: $id, input: { stateId: $stateId }) { success }
          }`,
          { id: issueId, stateId: backlogState.id },
          apiKey,
        );
      } else {
        console.warn(`[linear-failure-handler] "Backlog" state not found for issue ${issueId} — status not updated`);
      }

      console.log(`[linear-failure-handler] Failure notification posted for issue ${issueId}`);
    } catch (err) {
      console.error('[linear-failure-handler] Failed to notify Linear:', err);
    }
  }
}
