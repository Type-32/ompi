// Extension status text (e.g. ponytail's chip) arrives with terminal colour codes.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export const stripAnsi = (s: string): string => s.replace(ANSI, "");
