// Stands in for $EDITOR in the stage-pause pty test: rewrites the temp file
// non-interactively so the test never has to drive a real editor with keystrokes.
import { writeFileSync } from 'node:fs';

writeFileSync(process.argv[2], JSON.stringify({ summary: 'EDITED BY HUMAN' }, null, 2));
