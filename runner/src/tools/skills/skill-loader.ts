/**
 * Skill Loader - PLACEHOLDER for future dynamic skill loading
 *
 * TODO: Implement skill loading system that:
 * 1. Scans directories for skill.yaml files
 * 2. Parses YAML manifests and validates them
 * 3. Dynamically loads and registers tool implementations
 * 4. Manages skill dependencies and versions
 *
 * This is intentionally left unimplemented for v7 initial release.
 * Skills will be added in a future version when the core runner is stable.
 */

import type { Tool } from '../tool-registry.js';

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  tools: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
  dependencies?: Record<string, string>;
}

/**
 * Load skills from a directory (NOT YET IMPLEMENTED)
 * @param skillsPath - Path to skills directory
 * @returns Array of loaded tools
 */
export async function loadSkills(skillsPath: string): Promise<Tool[]> {
  // TODO: Implement skill loading
  console.warn('Skill loading not yet implemented. Returning empty array.');
  return [];
}

/**
 * Load a single skill from a directory (NOT YET IMPLEMENTED)
 * @param skillPath - Path to skill directory
 * @returns Array of tools from this skill
 */
export async function loadSkill(skillPath: string): Promise<Tool[]> {
  // TODO: Implement single skill loading
  console.warn('Skill loading not yet implemented. Returning empty array.');
  return [];
}

/**
 * Validate a skill manifest (NOT YET IMPLEMENTED)
 * @param manifest - Skill manifest to validate
 * @returns true if valid, throws error if invalid
 */
export function validateSkillManifest(manifest: SkillManifest): boolean {
  // TODO: Implement manifest validation
  throw new Error('Skill manifest validation not yet implemented');
}
