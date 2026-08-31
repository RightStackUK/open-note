import type { VaultFile } from './api';

export interface TreeFile {
  type: 'file';
  path: string;
  name: string;
  file: VaultFile;
}

export interface TreeFolder {
  type: 'folder';
  path: string;
  name: string;
  children: TreeNode[];
}

export type TreeNode = TreeFile | TreeFolder;

/**
 * Build a folder tree from the flat, slash-separated paths the backend returns.
 *
 * Folders sort before files, then both alphabetically case-insensitively — the
 * order a file manager would use, rather than raw byte order which scatters
 * capitalised names.
 */
export function buildTree(files: VaultFile[]): TreeNode[] {
  const root: TreeFolder = { type: 'folder', path: '', name: '', children: [] };
  const folders = new Map<string, TreeFolder>([['', root]]);

  const folderAt = (path: string): TreeFolder => {
    const existing = folders.get(path);
    if (existing) return existing;

    const slash = path.lastIndexOf('/');
    const parent = folderAt(slash === -1 ? '' : path.slice(0, slash));
    const folder: TreeFolder = {
      type: 'folder',
      path,
      name: path.slice(slash + 1),
      children: [],
    };
    folders.set(path, folder);
    parent.children.push(folder);
    return folder;
  };

  for (const file of files) {
    // The backend reports directories so that empty ones are visible: git
    // cannot store one, so no file path would ever imply it exists.
    if (file.kind === 'folder') {
      folderAt(file.path);
      continue;
    }
    const slash = file.path.lastIndexOf('/');
    const parent = folderAt(slash === -1 ? '' : file.path.slice(0, slash));
    parent.children.push({
      type: 'file',
      path: file.path,
      name: file.name || file.path.slice(slash + 1),
      file,
    });
  }

  sort(root);
  return root.children;
}

function sort(folder: TreeFolder) {
  folder.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  for (const child of folder.children) {
    if (child.type === 'folder') sort(child);
  }
}
