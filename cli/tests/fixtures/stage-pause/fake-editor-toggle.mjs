// Stands in for $EDITOR in the STU-1673 contract-revalidation pty test.
// First invocation drops the required `requirements` field (the human's bad
// edit); @inquirer/prompts keeps the rejected text and re-opens the editor,
// so the second invocation sees that same content still missing the field
// and adds it back (the human's fix). Content-based rather than a counter,
// so it stays correct regardless of how many times validation fails.
import { readFileSync, writeFileSync } from 'node:fs';

const path = process.argv[2];
const current = JSON.parse(readFileSync(path, 'utf-8'));

if ('requirements' in current) {
  delete current.requirements;
} else {
  current.requirements = ['fixed'];
}

writeFileSync(path, JSON.stringify(current, null, 2));
