import ora, { type Options, type Ora } from 'ora';

// ora's default `discardStdin: true` flips stdin into raw mode for the spinner's
// lifetime, which turns off the terminal's Ctrl-C→SIGINT translation. ora is meant
// to re-emit SIGINT itself in that mode, but the re-emit doesn't fire reliably here,
// so a run couldn't be cancelled while any spinner was on screen (STU-620 fixed the
// spinner redrawing over the notice; the notice never appeared because SIGINT never
// arrived). Keeping cooked mode means Ctrl-C always raises a real SIGINT.
export function makeSpinner(options: Options | string): Ora {
  const opts: Options = typeof options === 'string' ? { text: options } : options;
  return ora({ ...opts, discardStdin: false });
}
