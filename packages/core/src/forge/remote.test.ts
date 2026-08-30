import { describe, expect, it } from 'vitest';

import { forgeLabel, newPullRequestUrl, parseRemote } from './remote';

describe('parseRemote', () => {
  it('parses an SSH remote', () => {
    expect(parseRemote('git@github.com:owner/repo.git')).toMatchObject({
      host: 'github.com',
      owner: 'owner',
      repo: 'repo',
      kind: 'github',
    });
  });

  it('parses an HTTPS remote', () => {
    expect(parseRemote('https://github.com/owner/repo.git')).toMatchObject({
      host: 'github.com',
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('parses an HTTPS remote without the .git suffix', () => {
    expect(parseRemote('https://github.com/owner/repo')?.repo).toBe('repo');
  });

  it('parses an ssh:// URL with a port', () => {
    expect(parseRemote('ssh://git@github.com:22/owner/repo.git')).toMatchObject({
      host: 'github.com',
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('keeps nested GitLab groups in the owner', () => {
    // GitLab allows arbitrary nesting, and the API path needs the whole thing.
    expect(parseRemote('git@gitlab.com:group/subgroup/repo.git')).toMatchObject({
      owner: 'group/subgroup',
      repo: 'repo',
      kind: 'gitlab',
    });
  });

  it('recognises Bitbucket', () => {
    expect(parseRemote('git@bitbucket.org:team/repo.git')?.kind).toBe('bitbucket');
  });

  it('tolerates a trailing slash', () => {
    expect(parseRemote('https://github.com/owner/repo/')?.repo).toBe('repo');
  });

  it('is case-insensitive about the host', () => {
    expect(parseRemote('git@GitHub.com:owner/repo.git')?.kind).toBe('github');
  });

  it('guesses the forge for a self-hosted install', () => {
    expect(parseRemote('https://gitlab.example.com/team/repo.git')?.kind).toBe('gitlab');
    expect(parseRemote('git@github.enterprise.io:team/repo.git')?.kind).toBe('github');
  });

  it('reports an unrecognisable host as unknown rather than guessing', () => {
    const parsed = parseRemote('https://git.example.com/team/repo.git');
    expect(parsed?.kind).toBe('unknown');
    expect(parsed?.host).toBe('git.example.com');
  });

  it('builds a browsable web URL', () => {
    expect(parseRemote('git@github.com:owner/repo.git')?.webUrl).toBe(
      'https://github.com/owner/repo',
    );
  });

  it('returns null for a local path remote', () => {
    // Perfectly valid as a git remote; there is simply no forge behind it.
    expect(parseRemote('/Users/me/repos/notes.git')).toBeNull();
    expect(parseRemote('../other-repo')).toBeNull();
  });

  it('returns null for a file:// remote', () => {
    expect(parseRemote('file:///Users/me/repos/notes.git')).toBeNull();
  });

  it('returns null for a URL with no repository segment', () => {
    expect(parseRemote('https://github.com/owner')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseRemote('')).toBeNull();
    expect(parseRemote('   ')).toBeNull();
  });
});

describe('newPullRequestUrl', () => {
  const github = parseRemote('git@github.com:owner/repo.git');
  const gitlab = parseRemote('git@gitlab.com:group/sub/repo.git');
  const bitbucket = parseRemote('git@bitbucket.org:team/repo.git');
  const unknown = parseRemote('https://git.example.com/team/repo.git');

  it('builds a GitHub compare URL', () => {
    expect(newPullRequestUrl(github as never, 'feature', 'main')).toBe(
      'https://github.com/owner/repo/compare/main...feature?expand=1',
    );
  });

  it('builds a GitLab merge request URL', () => {
    const url = newPullRequestUrl(gitlab as never, 'feature', 'main') ?? '';
    expect(url).toContain('https://gitlab.com/group/sub/repo/-/merge_requests/new');
    expect(url).toContain('source_branch%5D=feature');
    expect(url).toContain('target_branch%5D=main');
  });

  it('builds a Bitbucket pull request URL', () => {
    expect(newPullRequestUrl(bitbucket as never, 'feature', 'main')).toBe(
      'https://bitbucket.org/team/repo/pull-requests/new?source=feature&dest=main',
    );
  });

  it('escapes branch names containing slashes', () => {
    const url = newPullRequestUrl(github as never, 'feat/new-thing', 'main') ?? '';
    expect(url).toContain('feat%2Fnew-thing');
  });

  it('returns null for an unidentified forge rather than guessing a URL', () => {
    // Sending someone to a wrong URL is worse than offering nothing.
    expect(newPullRequestUrl(unknown as never, 'feature', 'main')).toBeNull();
  });
});

describe('forgeLabel', () => {
  it('names the known forges', () => {
    expect(forgeLabel('github')).toBe('GitHub');
    expect(forgeLabel('gitlab')).toBe('GitLab');
    expect(forgeLabel('bitbucket')).toBe('Bitbucket');
  });

  it('stays vague about an unknown forge', () => {
    expect(forgeLabel('unknown')).toBe('this remote');
  });
});
