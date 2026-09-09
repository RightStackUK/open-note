import { describe, expect, it } from 'vitest';

import { fileIconName } from './fileIcons';

describe('fileIconName', () => {
  it('takes the kind Rust already decided, where Rust was specific', () => {
    // Disagreeing here would show a picture frame beside a file the previewer
    // then refuses to preview — the classification has to have one owner.
    expect(fileIconName('shots/a.png', 'image')).toBe('image');
    expect(fileIconName('notes/idea.md', 'markdown')).toBe('markdown');
    expect(fileIconName('sketch.excalidraw', 'drawing')).toBe('drawing');
    expect(fileIconName('paper.pdf', 'pdf')).toBe('pdf');
    expect(fileIconName('Projects', 'folder')).toBe('folder');
  });

  it('splits by extension what FileKind lumps into text and other', () => {
    // The whole point of the issue: these all arrive as `text`.
    expect(fileIconName('src/app.ts', 'text')).toBe('code');
    expect(fileIconName('src/app.tsx', 'text')).toBe('code');
    expect(fileIconName('main.rs', 'text')).toBe('code');
    expect(fileIconName('package.json', 'text')).toBe('data');
    expect(fileIconName('ci/config.yaml', 'text')).toBe('data');
    expect(fileIconName('deploy.sh', 'text')).toBe('shell');
    expect(fileIconName('styles.css', 'text')).toBe('web');
    expect(fileIconName('index.html', 'text')).toBe('web');
    expect(fileIconName('backup.zip', 'other')).toBe('archive');
  });

  it('is case-insensitive about extensions', () => {
    expect(fileIconName('NOTES/Thing.JSON', 'text')).toBe('data');
    expect(fileIconName('App.TSX', 'text')).toBe('code');
  });

  it('recognises the files whose name is the type', () => {
    // A repository is full of these, and an extension test alone leaves them
    // as anonymous pages next to their own docker-compose.yml.
    expect(fileIconName('Dockerfile', 'text')).toBe('code');
    expect(fileIconName('build/Makefile', 'text')).toBe('code');
    expect(fileIconName('.gitignore', 'text')).toBe('data');
    expect(fileIconName('.editorconfig', 'text')).toBe('data');
  });

  it('does not read a leading dot as an extension', () => {
    // `.gitignore` has no extension; treating `gitignore` as one would make
    // every dotfile match whatever family happened to share its name.
    expect(fileIconName('.zshrc', 'text')).toBe('file');
    expect(fileIconName('trailing.', 'text')).toBe('file');
  });

  it('falls back to a plain page rather than guessing', () => {
    expect(fileIconName('notes/LICENSE', 'text')).toBe('file');
    expect(fileIconName('data.sqlite3', 'other')).toBe('file');
    expect(fileIconName('README', 'text')).toBe('file');
  });

  it('reads the extension of the file, not of a folder above it', () => {
    expect(fileIconName('site.css/notes', 'text')).toBe('file');
    expect(fileIconName('v1.2/run', 'text')).toBe('file');
  });
});
