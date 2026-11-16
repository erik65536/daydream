/**
 * Account administration from the server's console (for the first administrator, or when locked out).
 *
 *   node src/cli/users.ts list
 *   node src/cli/users.ts invite <name>                 a new account for <name> (who it is for): prints its invite link
 *   node src/cli/users.ts reset <username or id>        invited again with a new code (password and passkeys removed)
 *   node src/cli/users.ts admin <username or id> on|off
 *   node src/cli/users.ts unlock <username or id>       takes passwords again after too many wrong ones
 *   node src/cli/users.ts ips [<username or id>]        the addresses an account signed in and played from; without a
 *                                                      name, every address more than one account used
 *   node src/cli/users.ts activity [<username or id>] [days]   each account's sign-ins, worlds, adventures, and time
 *                                                      played over the last days (30); with a name, its latest events
 *
 * An account not set up yet has no user name: use its id (from list), e.g. when its invite ran out.
 *
 * The invite link is the site's address followed by /#/invite/<code>.
 */
import { createUser, findUser, getUser, listUsers, resetUser, setAdmin, unlockUser } from '../storage.ts';
import { activityOf, activitySince, addressesOf, sharedAddresses, type AddressUse } from '../log.ts';

const [cmd, name, arg] = process.argv.slice(2);
const user = () => {
  const u = name && (findUser(name) ?? getUser(name));
  if (!u) throw new Error(`No user "${name ?? ''}".`);
  return u;
};
const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const nameOf = (id: string) => { const u = getUser(id); return u?.username ?? u?.displayName ?? id; };
const addressLine = (a: AddressUse, who: string) => console.log(`${a.ip.padEnd(40)} ${who.padEnd(24)} ${String(a.count).padStart(5)}×  ${day(a.firstAt)} to ${day(a.lastAt)}`);
const link = (code: string | null) => `invite link: <this site>/#/invite/${code}`;
switch (cmd) {
  case 'list':
    for (const u of listUsers()) console.log(`${u.id.padEnd(16)} ${(u.username ?? '(not chosen yet)').padEnd(24)} ${u.displayName.padEnd(24)} ${u.isAdmin ? 'admin ' : 'player'} ${u.status}${u.status === 'invited' ? ` (code ${u.inviteCode})` : ''}${u.blocked ? ', locked after wrong passwords' : (u.lockedUntil ?? 0) > Date.now() ? ', waiting after wrong passwords' : ''}`);
    break;
  case 'invite': {
    const u = createUser({ displayName: name ?? '' });
    console.log(`Invited "${u.displayName}" (they choose their user name; make them an administrator after they set up); ${link(u.inviteCode)}`);
    break;
  }
  case 'reset': {
    const u = resetUser(user().id);
    console.log(`"${u.username ?? u.displayName}" must be set up again; ${link(u.inviteCode)}`);
    break;
  }
  case 'admin':
    setAdmin(user().id, arg === 'on');
    console.log(`"${user().username ?? user().displayName}" is now ${arg === 'on' ? 'an administrator' : 'a player'}.`);
    break;
  case 'unlock':
    unlockUser(user().id);
    console.log(`"${user().username ?? user().displayName}" takes passwords again.`);
    break;
  case 'ips':
    if (name) for (const a of addressesOf(user().id)) addressLine(a, nameOf(a.userId));
    else for (const a of sharedAddresses()) addressLine(a, nameOf(a.userId));
    break;
  case 'activity': {
    const days = Number((name && /^\d+$/.test(name) ? name : arg) ?? 30) || 30;
    if (name && !/^\d+$/.test(name)) {
      for (const a of activityOf(user().id).reverse())
        console.log(`${new Date(a.at).toISOString().slice(0, 16).replace('T', ' ')}  ${a.event.padEnd(18)} ${(a.worldId ?? '').padEnd(14)} ${(a.adventureId ?? '').padEnd(14)} ${JSON.stringify(a.detail)}`);
      break;
    }
    const by = new Map<string, { signIns: number; worlds: number; built: number; adventures: number; sessions: number; minutes: number; played: Set<string> }>();
    for (const a of activitySince(Date.now() - days * 86_400_000)) {
      const u = by.get(a.userId) ?? { signIns: 0, worlds: 0, built: 0, adventures: 0, sessions: 0, minutes: 0, played: new Set<string>() };
      by.set(a.userId, u);
      if (a.event === 'signed in') u.signIns++;
      else if (a.event === 'world started') u.worlds++;
      else if (a.event === 'world built') u.built++;
      else if (a.event === 'adventure started') u.adventures++;
      else if (a.event === 'played') {
        u.sessions++;
        u.minutes += Number(a.detail.minutes ?? 0);
        if (a.worldId) u.played.add(a.worldId);
      }
    }
    console.log(`Last ${days} days:`);
    console.log(`${'account'.padEnd(24)} sign-ins  worlds (built)  adventures  sessions  hours  worlds played`);
    for (const [id, u] of [...by].sort((a, b) => b[1].minutes - a[1].minutes))
      console.log(`${nameOf(id).padEnd(24)} ${String(u.signIns).padStart(8)}  ${`${u.worlds} (${u.built})`.padStart(13)}  ${String(u.adventures).padStart(10)}  ${String(u.sessions).padStart(8)}  ${(u.minutes / 60).toFixed(1).padStart(5)}  ${String(u.played.size).padStart(13)}`);
    break;
  }
  default:
    console.log('usage: users list | invite <name> | reset <username or id> | admin <username or id> on|off | unlock <username or id> | ips [<username or id>] | activity [<username or id>] [days]');
}
