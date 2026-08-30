/**
 * Understanding a git remote URL.
 *
 * Parsing is here, in platform-agnostic code, rather than in the API clients:
 * the same URL shapes have to be recognised on desktop and on mobile, and the
 * rules are fiddly enough to deserve their own tests.
 */

export type ForgeKind = 'github' | 'gitlab' | 'bitbucket' | 'unknown';

export interface ParsedRemote {
  /** Hostname, e.g. `github.com` or `git.example.com`. */
  host: string;
  /**
   * Everything between the host and the repository name. Usually one segment,
   * but GitLab allows arbitrarily nested groups.
   */
  owner: string;
  repo: string;
  kind: ForgeKind;
  /** Browsable URL for the repository. */
  webUrl: string;
}

const KNOWN_HOSTS: Record<string, ForgeKind> = {
  'github.com': 'github',
  'www.github.com': 'github',
  'gitlab.com': 'gitlab',
  'www.gitlab.com': 'gitlab',
  'bitbucket.org': 'bitbucket',
  'www.bitbucket.org': 'bitbucket',
};

/**
 * Guess the forge for a self-hosted install.
 *
 * A host of `gitlab.example.com` is almost certainly GitLab. This is only a
 * hint: the user can always correct it, and `unknown` simply means we do not
 * offer pull-request features rather than that anything is broken.
 */
function kindForHost(host: string): ForgeKind {
  const known = KNOWN_HOSTS[host.toLowerCase()];
  if (known) return known;

  const lowered = host.toLowerCase();
  if (lowered.includes('github')) return 'github';
  if (lowered.includes('gitlab')) return 'gitlab';
  if (lowered.includes('bitbucket')) return 'bitbucket';
  return 'unknown';
}

function stripGitSuffix(path: string): string {
  return path.replace(/\.git$/i, '').replace(/\/+$/, '');
}

/**
 * Parse a remote URL in any of the forms git accepts.
 *
 * Handles `git@host:owner/repo.git` (scp-like), `https://host/owner/repo.git`,
 * `ssh://git@host:port/owner/repo`, and nested GitLab groups. Returns `null`
 * for anything unrecognisable — a local path remote, for instance, which is
 * perfectly valid but has no forge behind it.
 */
export function parseRemote(url: string): ParsedRemote | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  let host: string;
  let path: string;

  // scp-like: [user@]host:path — no scheme, and the colon is not a port.
  const scpLike = /^(?:([^@/]+)@)?([^/:]+):(?!\/)(.+)$/.exec(trimmed);
  if (scpLike && !trimmed.includes('://')) {
    host = scpLike[2] ?? '';
    path = scpLike[3] ?? '';
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    // file:// and plain paths have no forge behind them.
    if (!parsed.hostname) return null;
    host = parsed.hostname;
    path = parsed.pathname;
  }

  const segments = stripGitSuffix(path)
    .split('/')
    .filter((segment) => segment.length > 0);
  if (segments.length < 2) return null;

  const repo = segments[segments.length - 1] as string;
  const owner = segments.slice(0, -1).join('/');
  const kind = kindForHost(host);

  return {
    host,
    owner,
    repo,
    kind,
    webUrl: `https://${host}/${owner}/${repo}`,
  };
}

/** The URL that opens a "create pull request" page in a browser. */
export function newPullRequestUrl(
  remote: ParsedRemote,
  branch: string,
  base: string,
): string | null {
  const encodedBranch = encodeURIComponent(branch);
  const encodedBase = encodeURIComponent(base);

  switch (remote.kind) {
    case 'github':
      return `${remote.webUrl}/compare/${encodedBase}...${encodedBranch}?expand=1`;
    case 'gitlab':
      return (
        `${remote.webUrl}/-/merge_requests/new` +
        `?merge_request%5Bsource_branch%5D=${encodedBranch}` +
        `&merge_request%5Btarget_branch%5D=${encodedBase}`
      );
    case 'bitbucket':
      return `${remote.webUrl}/pull-requests/new?source=${encodedBranch}&dest=${encodedBase}`;
    default:
      // A self-hosted forge we cannot identify: there is no reliable URL shape
      // to guess, and sending the user somewhere wrong is worse than nothing.
      return null;
  }
}

/** Human-readable provider name, for buttons and messages. */
export function forgeLabel(kind: ForgeKind): string {
  switch (kind) {
    case 'github':
      return 'GitHub';
    case 'gitlab':
      return 'GitLab';
    case 'bitbucket':
      return 'Bitbucket';
    default:
      return 'this remote';
  }
}
