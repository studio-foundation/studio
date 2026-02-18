// Post-validation sémantique
//
// Vérifie le CONTENU de l'output après que ralph a validé le FORMAT.
// Utilisé pour les stages avec une gate d'approbation — l'agent peut
// retourner un JSON valide qui dit quand même "non".
//
// Configuré dans le contract YAML via la section "post_validation".

import type { OutputContract } from '@studio/contracts';

export interface PostValidationResult {
  accepted: boolean;
  rejection_reason?: string;
  rejection_details?: string[];
}

export function postValidate(
  output: unknown,
  contract: OutputContract
): PostValidationResult {
  // No post_validation config → everything is accepted
  if (!contract.post_validation?.rejection_detection) {
    return { accepted: true };
  }

  const { field, approved_values, rejected_values, details_field, summary_field, reject_if_non_empty } =
    contract.post_validation.rejection_detection;

  if (!field) {
    return { accepted: true };
  }

  // Extract field value from output
  if (!output || typeof output !== 'object') {
    return { accepted: true };
  }

  const o = output as Record<string, unknown>;
  const actualValue = o[field];

  if (typeof actualValue !== 'string') {
    return { accepted: true };
  }

  // Check reject_if_non_empty before approved_values — a non-empty field always rejects
  if (reject_if_non_empty) {
    const fieldValue = o[reject_if_non_empty];
    if (Array.isArray(fieldValue) && fieldValue.length > 0) {
      const details = fieldValue
        .map(item => typeof item === 'string' ? item : (item as Record<string, unknown>)?.description)
        .filter((d): d is string => typeof d === 'string');

      const summary = summary_field && typeof o[summary_field] === 'string'
        ? (o[summary_field] as string)
        : undefined;

      return {
        accepted: false,
        rejection_reason: `Rejected: ${reject_if_non_empty} is non-empty (${fieldValue.length} items)${summary ? `. ${summary}` : ''}`,
        rejection_details: details.length > 0 ? details : undefined,
      };
    }
  }

  // Check approved values (if specified)
  if (approved_values?.length && approved_values.includes(actualValue)) {
    return { accepted: true };
  }

  // Check rejected values (if specified)
  if (rejected_values?.length && !rejected_values.includes(actualValue)) {
    // Value is not in rejected list and no approved list matched → accept
    if (!approved_values?.length) {
      return { accepted: true };
    }
  }

  // If we have approved_values and the value isn't in them → rejected
  // If we have rejected_values and the value is in them → rejected

  // Extract details from configured field
  const details: string[] = [];
  if (details_field) {
    const detailsValue = o[details_field];
    if (typeof detailsValue === 'string' && detailsValue.length > 0) {
      details.push(detailsValue);
    } else if (Array.isArray(detailsValue)) {
      for (const item of detailsValue) {
        if (typeof item === 'string') {
          details.push(item);
        } else if (typeof item === 'object' && item !== null) {
          const desc = (item as Record<string, unknown>).description;
          if (typeof desc === 'string') details.push(desc);
        }
      }
    }
  }

  // Extract summary from configured field
  const summary = summary_field && typeof o[summary_field] === 'string'
    ? (o[summary_field] as string)
    : undefined;

  return {
    accepted: false,
    rejection_reason: `Rejected: ${field} = "${actualValue}" (expected: ${(approved_values ?? []).join(' or ')})${summary ? `. ${summary}` : ''}`,
    rejection_details: details.length > 0 ? details : undefined,
  };
}
