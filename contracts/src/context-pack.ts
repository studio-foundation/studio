// Shared types for the context packs feature (STU-13)

export interface ContextPackDefinition {
  name: string;
  description?: string;
  version: number;
  files?: Array<{ path: string }>;
  inline?: Array<{ title: string; content: string }>;
}

export interface ResolvedContextPack {
  name: string;
  description?: string;
  sections: Array<{ title: string; content: string }>;
}
