/**
 * Web search tool - search the web using the Tavily API
 */

import type { Tool } from '../tool-registry.js';

const TAVILY_API_URL = 'https://api.tavily.com/search';

export const WEB_SEARCH_PROMPT_SNIPPET = `
## web_search tool

Use \`web_search-search\` to search the web for up-to-date information.
Search in the language most relevant to the query (e.g. English for technical docs, French for local content).
Prefer specific, targeted queries over broad ones for better results.
`.trim();

export function createWebSearchTools(): Tool[] {
  return [
    {
      name: 'web_search-search',
      description: 'Search the web using Tavily and return relevant results',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query'
          },
          max_results: {
            type: 'number',
            description: 'Maximum number of results to return (default: 5)'
          }
        },
        required: ['query']
      },
      execute: async ({ query, max_results }) => {
        const apiKey = process.env.TAVILY_API_KEY;
        if (!apiKey) {
          return {
            success: false,
            output: null,
            error: 'TAVILY_API_KEY environment variable is not set'
          };
        }

        const q = query as string;
        const limit = (max_results as number | undefined) ?? 5;

        try {
          const response = await fetch(TAVILY_API_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
              query: q,
              max_results: limit
            })
          });

          if (!response.ok) {
            const text = await response.text();
            return {
              success: false,
              output: null,
              error: `Tavily API error ${response.status}: ${text}`
            };
          }

          const data = await response.json() as {
            results?: Array<{ title: string; url: string; content: string; score?: number }>;
            answer?: string;
          };

          return {
            success: true,
            output: {
              query: q,
              results: (data.results ?? []).map(r => ({
                title: r.title,
                url: r.url,
                content: r.content,
                score: r.score
              })),
              answer: data.answer ?? null,
              count: (data.results ?? []).length
            }
          };
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            output: null,
            error: `Web search failed: ${errorMessage}`
          };
        }
      }
    }
  ];
}
