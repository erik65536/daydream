// This checkout's own packages linked into its node_modules (checkout.ts, linkWorkspaces): `npm run typecheck` runs it
// first, so a worktree is checked against its own shared code.
import { linkWorkspaces } from '../packages/server/src/checkout.ts';

linkWorkspaces();
